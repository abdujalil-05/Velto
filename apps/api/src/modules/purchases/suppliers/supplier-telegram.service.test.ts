import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { AuthService } from '../../auth/auth.service';
import type { LoginRateLimiterService } from '../../auth/login-rate-limiter.service';
import { SupplierTelegramAlreadyLinkedException, SupplierTelegramNotLinkedException } from '../purchases-exceptions';
import { SupplierTelegramService } from './supplier-telegram.service';
import { SuppliersService } from './suppliers.service';

const BOT_USERNAME = 'velto_test_bot';

/**
 * SupplierTelegramService and AuthService both read config through
 * ConfigService, which falls through to process.env — and the repo's real
 * .env carries a live TELEGRAM_BOT_TOKEN. Pin both values here so the tests
 * never depend on (or leak into) the developer's environment; `fetch` is
 * stubbed below regardless, so no request leaves the process either way.
 */
function stubConfig(overrides: Record<string, string>): ConfigService {
  return {
    get: (key: string, defaultValue?: string) => overrides[key] ?? defaultValue,
  } as unknown as ConfigService;
}

describe('Supplier Telegram linking (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const suppliers = new SuppliersService(tenantPrisma, auditLog);
  const telegram = new SupplierTelegramService(
    tenantPrisma,
    auditLog,
    suppliers,
    stubConfig({ TELEGRAM_BOT_USERNAME: BOT_USERNAME }),
  );
  const auth = new AuthService(
    new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m' } }),
    // A bot token must be present or replyTelegram() short-circuits and the
    // reply assertions below would pass vacuously. It is never sent anywhere:
    // global fetch is stubbed in beforeEach.
    stubConfig({ TELEGRAM_BOT_TOKEN: 'test-bot-token' }),
    tenantPrisma,
    // The webhook redemption path never consults the login rate limiter.
    undefined as unknown as LoginRateLimiterService,
    auditLog,
  );

  /** Every `sendMessage` body the code under test tried to send, newest last. */
  let sentMessages: string[];

  function lastReply(): string | undefined {
    return sentMessages.at(-1);
  }

  // Random, not sequential: test data isn't truncated between runs, and
  // SupplierTelegramLink is unique on (companyId, telegramId).
  function fakeTelegramId(): number {
    return 700_000_000 + Math.floor(Math.random() * 99_000_000);
  }

  async function createSupplier(name: string): Promise<string> {
    return tenantPrisma.run(companyId, async (tx) => {
      const supplier = await tx.supplier.create({ data: { companyId, name } });
      return supplier.id;
    });
  }

  function sendStart(telegramId: number, payload?: string, username?: string) {
    return auth.handleTelegramUpdate({
      message: { from: { id: telegramId, username }, text: payload ? `/start ${payload}` : '/start' },
    });
  }

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-supplier-tg-${Date.now()}`, name: 'Supplier TG Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Supplier TG Test Co' } });
    companyId = company.id;

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Ware', lastName: 'House', phone: `+99890${Math.floor(1_000_000 + Math.random() * 8_000_000)}` },
    });
    user = {
      id: dbUser.id,
      companyId,
      firstName: 'Ware',
      lastName: 'House',
      roles: ['WAREHOUSE'],
      permissions: ['purchases.read', 'purchases.update'],
    };
  });

  beforeEach(() => {
    sentMessages = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        sentMessages.push((JSON.parse(init?.body ?? '{}') as { text?: string }).text ?? '');
        return { ok: true } as Response;
      }),
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('issues a CSPRNG code with a deep link, and never writes the code itself to AuditLog', async () => {
    const supplierId = await createSupplier('Code Co');

    const issued = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierId, user));

    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/); // Crockford base32, 80 bits
    expect(issued.deepLink).toBe(`https://t.me/${BOT_USERNAME}?start=${issued.code}`);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const audit = await tenantPrisma.run(companyId, (tx) =>
      tx.auditLog.findFirst({ where: { entityId: supplierId, action: 'supplier.telegram_link_code_issued' } }),
    );
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit?.newValue)).not.toContain(issued.code);
  });

  it('returns deepLink: null when TELEGRAM_BOT_USERNAME is unset', async () => {
    const supplierId = await createSupplier('No Bot Co');
    const noBot = new SupplierTelegramService(tenantPrisma, auditLog, suppliers, stubConfig({}));

    const issued = await tenantPrisma.run(companyId, () => noBot.issueLinkCode(supplierId, user));
    expect(issued.deepLink).toBeNull();
    expect(issued.code).toHaveLength(16);
  });

  it('links the supplier when the code is redeemed via /start <code>', async () => {
    const supplierId = await createSupplier('Happy Path Co');
    const telegramId = fakeTelegramId();

    const issued = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierId, user));
    await sendStart(telegramId, issued.code, 'happy_supplier');

    const link = await tenantPrisma.run(companyId, (tx) =>
      tx.supplierTelegramLink.findFirst({ where: { supplierId } }),
    );
    expect(link?.telegramId).toBe(BigInt(telegramId));
    expect(link?.username).toBe('happy_supplier');
    expect(link?.isActive).toBe(true);

    const code = await systemPrisma.supplierTelegramLinkCode.findUnique({ where: { code: issued.code } });
    expect(code?.usedAt).not.toBeNull();

    const audit = await tenantPrisma.run(companyId, (tx) =>
      tx.auditLog.findFirst({ where: { entityId: supplierId, action: 'supplier.telegram_linked' } }),
    );
    expect(audit).toBeTruthy();
    expect(lastReply()).toContain("Bog'landi");

    // GET /suppliers/:id/telegram — telegramId must be a *string* (BigInt is
    // not JSON-serializable).
    const status = await tenantPrisma.run(companyId, () => telegram.getStatus(supplierId));
    expect(status).toMatchObject({ linked: true, telegramId: String(telegramId), username: 'happy_supplier', pendingCode: null });
    expect(typeof status.linkedAt).toBe('string');
  });

  it('reports a pending code in the status until it is redeemed', async () => {
    const supplierId = await createSupplier('Pending Co');
    const issued = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierId, user));

    const status = await tenantPrisma.run(companyId, () => telegram.getStatus(supplierId));
    expect(status.linked).toBe(false);
    expect(status.telegramId).toBeNull();
    expect(status.pendingCode).toEqual(issued);
  });

  it('rejects an expired code without linking, with an opaque reply', async () => {
    const supplierId = await createSupplier('Expired Co');
    const telegramId = fakeTelegramId();

    const issued = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierId, user));
    await systemPrisma.supplierTelegramLinkCode.update({
      where: { code: issued.code },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await sendStart(telegramId, issued.code);

    const link = await tenantPrisma.run(companyId, (tx) =>
      tx.supplierTelegramLink.findFirst({ where: { supplierId } }),
    );
    expect(link).toBeNull();
    expect(lastReply()).toBe("Kod yaroqsiz yoki muddati tugagan. Administratoringizdan yangi kod so'rang.");
  });

  it('rejects an unknown code with the same reply as an expired one (no enumeration signal)', async () => {
    await sendStart(fakeTelegramId(), 'ZZZZZZZZZZZZZZZZ');
    expect(lastReply()).toBe("Kod yaroqsiz yoki muddati tugagan. Administratoringizdan yangi kod so'rang.");
  });

  it('is single-use: replaying a code never re-links, and a stranger gets the opaque reply', async () => {
    const supplierId = await createSupplier('Replay Co');
    const telegramId = fakeTelegramId();
    const strangerId = fakeTelegramId();

    const issued = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierId, user));
    await sendStart(telegramId, issued.code);

    // Same account replays it — idempotent, friendly wording.
    await sendStart(telegramId, issued.code);
    expect(lastReply()).toContain("allaqachon bog'langansiz");

    // Someone else with the same (already burnt) code learns nothing.
    await sendStart(strangerId, issued.code);
    expect(lastReply()).toBe("Kod yaroqsiz yoki muddati tugagan. Administratoringizdan yangi kod so'rang.");

    const link = await tenantPrisma.run(companyId, (tx) =>
      tx.supplierTelegramLink.findFirst({ where: { supplierId } }),
    );
    expect(link?.telegramId).toBe(BigInt(telegramId)); // never reassigned to the stranger
  });

  it('invalidates a previously issued unused code when a new one is generated', async () => {
    const supplierId = await createSupplier('Rotate Co');
    const first = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierId, user));
    const second = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierId, user));

    expect(second.code).not.toBe(first.code);
    expect(await systemPrisma.supplierTelegramLinkCode.findUnique({ where: { code: first.code } })).toBeNull();

    await sendStart(fakeTelegramId(), first.code);
    expect(lastReply()).toBe("Kod yaroqsiz yoki muddati tugagan. Administratoringizdan yangi kod so'rang.");
  });

  it('refuses to issue a code while the supplier is still linked', async () => {
    const supplierId = await createSupplier('Already Linked Co');
    const issued = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierId, user));
    await sendStart(fakeTelegramId(), issued.code);

    await expect(tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierId, user))).rejects.toBeInstanceOf(
      SupplierTelegramAlreadyLinkedException,
    );
  });

  it('re-links to a different Telegram account after an unlink (no P2002 on @@unique([supplierId]))', async () => {
    const supplierId = await createSupplier('Relink Co');
    const firstTgId = fakeTelegramId();
    const secondTgId = fakeTelegramId();

    const first = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierId, user));
    await sendStart(firstTgId, first.code, 'first_contact');

    const afterUnlink = await tenantPrisma.run(companyId, () => telegram.unlink(supplierId, user));
    expect(afterUnlink).toEqual({ linked: false, telegramId: null, username: null, linkedAt: null, pendingCode: null });

    const second = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierId, user));
    await sendStart(secondTgId, second.code, 'second_contact');
    expect(lastReply()).toContain("Bog'landi");

    const links = await tenantPrisma.run(companyId, (tx) => tx.supplierTelegramLink.findMany({ where: { supplierId } }));
    expect(links).toHaveLength(1);
    expect(links[0].telegramId).toBe(BigInt(secondTgId));
    expect(links[0].username).toBe('second_contact');

    const audit = await tenantPrisma.run(companyId, (tx) =>
      tx.auditLog.findFirst({ where: { entityId: supplierId, action: 'supplier.telegram_unlinked' } }),
    );
    expect(audit).toBeTruthy();
  });

  it('rejects an unlink when nothing is linked', async () => {
    const supplierId = await createSupplier('Never Linked Co');
    await expect(tenantPrisma.run(companyId, () => telegram.unlink(supplierId, user))).rejects.toBeInstanceOf(
      SupplierTelegramNotLinkedException,
    );
  });

  it('refuses to move a Telegram account that is already linked to another supplier', async () => {
    const supplierA = await createSupplier('Taken A');
    const supplierB = await createSupplier('Taken B');
    const telegramId = fakeTelegramId();

    const codeA = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierA, user));
    await sendStart(telegramId, codeA.code);

    const codeB = await tenantPrisma.run(companyId, () => telegram.issueLinkCode(supplierB, user));
    await sendStart(telegramId, codeB.code);

    expect(lastReply()).toContain('boshqa yetkazib beruvchiga');
    const linkB = await tenantPrisma.run(companyId, (tx) =>
      tx.supplierTelegramLink.findFirst({ where: { supplierId: supplierB } }),
    );
    expect(linkB).toBeNull();
    // The rejected attempt must not burn supplier B's code either.
    const codeRow = await systemPrisma.supplierTelegramLinkCode.findUnique({ where: { code: codeB.code } });
    expect(codeRow?.usedAt).toBeNull();
  });

  it('a bare /start is still a no-op (no code, no reply)', async () => {
    await sendStart(fakeTelegramId());
    expect(sentMessages).toEqual([]);
  });
});
