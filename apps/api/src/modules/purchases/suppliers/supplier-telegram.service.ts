import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type TenantClient } from '@velto/database';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import {
  SupplierTelegramAlreadyLinkedException,
  SupplierTelegramNotLinkedException,
} from '../purchases-exceptions';
import { SuppliersService } from './suppliers.service';

/**
 * Crockford base32 — the digits/letters that survive being read off a screen
 * and retyped into Telegram (no I/L/O/U, so nothing reads as 1/0). 32 chars
 * exactly, and 256 % 32 === 0, so `byte % 32` below is bias-free.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 16 chars * 5 bits = 80 bits of CSPRNG entropy. */
const CODE_LENGTH = 16;
/** Deliberately short: the code is a bearer secret sent over an out-of-band channel. */
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_COLLISION_RETRIES = 3;

export interface PendingLinkCode {
  code: string;
  expiresAt: string;
  deepLink: string | null;
}

export interface SupplierTelegramStatus {
  linked: boolean;
  /** BigInt in the DB — serialized as a string, since JSON.stringify() throws on BigInt. */
  telegramId: string | null;
  username: string | null;
  linkedAt: string | null;
  pendingCode: PendingLinkCode | null;
}

/**
 * Issues / inspects / revokes the one-time code a supplier redeems by sending
 * `/start <code>` to the bot. The redemption side deliberately lives in
 * AuthService (it runs off the Telegram webhook, before any companyId is
 * known, so it must resolve the code through `systemPrisma` first) — this
 * service only ever runs inside an authenticated, tenant-scoped request.
 */
@Injectable()
export class SupplierTelegramService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly suppliers: SuppliersService,
    private readonly config: ConfigService,
  ) {}

  /**
   * `SupplierTelegramLinkCode.code` is globally unique (see its schema doc) —
   * a guessable value there would turn that unique into a cross-tenant
   * existence oracle, so this must stay a CSPRNG draw, never a counter.
   */
  private generateCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let code = '';
    for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    return code;
  }

  private deepLink(code: string): string | null {
    const botUsername = this.config.get<string>('TELEGRAM_BOT_USERNAME', '');
    // Empty when the bot isn't configured — return null rather than a URL that
    // resolves to a "user not found" page in Telegram. The raw code still works.
    if (!botUsername) return null;
    return `https://t.me/${botUsername}?start=${code}`;
  }

  private toPending(row: { code: string; expiresAt: Date }): PendingLinkCode {
    return { code: row.code, expiresAt: row.expiresAt.toISOString(), deepLink: this.deepLink(row.code) };
  }

  async issueLinkCode(supplierId: string, user: AuthenticatedUser): Promise<PendingLinkCode> {
    const tx = this.tenantPrisma.client;
    await this.suppliers.findActiveOrThrow(tx, supplierId);

    const existingLink = await tx.supplierTelegramLink.findFirst({ where: { supplierId, isActive: true } });
    if (existingLink) throw new SupplierTelegramAlreadyLinkedException();

    // Single outstanding code per supplier: a freshly issued one must be the
    // only redeemable secret, otherwise an old code handed to the wrong person
    // stays live for its full TTL.
    await tx.supplierTelegramLinkCode.deleteMany({ where: { supplierId, usedAt: null } });

    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const row = await tx.supplierTelegramLinkCode.create({
          data: {
            companyId: user.companyId,
            supplierId,
            code: this.generateCode(),
            expiresAt,
            createdById: user.id,
          },
        });

        await this.auditLog.log(tx, {
          companyId: user.companyId,
          userId: user.id,
          action: 'supplier.telegram_link_code_issued',
          entity: 'Supplier',
          entityId: supplierId,
          // The code itself is a bearer secret — never write it to AuditLog,
          // which is readable by anyone with audit access and is append-only
          // (it could never be redacted afterwards).
          newValue: { linkCodeId: row.id, expiresAt: row.expiresAt.toISOString() },
        });

        return this.toPending(row);
      } catch (error) {
        // 80 bits makes this effectively unreachable, but a global unique that
        // ever does collide must not surface as a 500 to the admin.
        const isCollision =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!isCollision || attempt >= CODE_COLLISION_RETRIES) throw error;
      }
    }
  }

  async getStatus(supplierId: string): Promise<SupplierTelegramStatus> {
    const tx = this.tenantPrisma.client;
    await this.suppliers.findActiveOrThrow(tx, supplierId);
    return this.readStatus(tx, supplierId);
  }

  private async readStatus(tx: TenantClient, supplierId: string): Promise<SupplierTelegramStatus> {
    const link = await tx.supplierTelegramLink.findFirst({ where: { supplierId, isActive: true } });
    const pending = link
      ? null
      : await tx.supplierTelegramLinkCode.findFirst({
          where: { supplierId, usedAt: null, expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
        });

    return {
      linked: link !== null,
      telegramId: link ? link.telegramId.toString() : null,
      username: link?.username ?? null,
      linkedAt: link ? link.linkedAt.toISOString() : null,
      pendingCode: pending ? this.toPending(pending) : null,
    };
  }

  /**
   * Hard-deletes the link row rather than flipping `isActive` to false.
   * `@@unique([companyId, telegramId])` means a retained inactive row would
   * permanently block that Telegram account from linking to a *different*
   * supplier in the same company (a contact person moving between suppliers) —
   * and the row carries no history worth keeping, since AuditLog (append-only)
   * already records both the link and this unlink. The redemption path still
   * upserts on `supplierId` so it stays correct either way.
   */
  async unlink(supplierId: string, user: AuthenticatedUser): Promise<SupplierTelegramStatus> {
    const tx = this.tenantPrisma.client;
    await this.suppliers.findActiveOrThrow(tx, supplierId);

    const link = await tx.supplierTelegramLink.findFirst({ where: { supplierId, isActive: true } });
    if (!link) throw new SupplierTelegramNotLinkedException();

    await tx.supplierTelegramLink.delete({ where: { id: link.id } });
    // Any code still outstanding was issued for the account just removed.
    await tx.supplierTelegramLinkCode.deleteMany({ where: { supplierId, usedAt: null } });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'supplier.telegram_unlinked',
      entity: 'Supplier',
      entityId: supplierId,
      // Built by hand, not via toAuditJson(): the row holds a BigInt telegramId
      // and JSON.stringify() throws on BigInt.
      oldValue: { telegramId: link.telegramId.toString(), username: link.username, linkedAt: link.linkedAt.toISOString() },
    });

    return this.readStatus(tx, supplierId);
  }
}
