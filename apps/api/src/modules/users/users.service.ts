import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { Prisma, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { paginate } from '../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  CannotDeactivateSelfException,
  CannotGrantOwnerRoleException,
  CannotSetOthersPasswordException,
  DuplicateUserPhoneException,
  InvalidRoleCodesException,
  LastOwnerException,
  UserAlreadyActiveException,
  UserAlreadyInactiveException,
  UserNotFoundException,
} from './users-exceptions';
import type { CreateUserDto } from './dto/create-user.dto';
import type { ListUsersQueryDto } from './dto/list-users.query';
import type { UpdateUserDto } from './dto/update-user.dto';

const USER_SAFE_SELECT = {
  id: true,
  companyId: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  roles: { select: { role: { select: { id: true, code: true, name: true } } } },
} satisfies Prisma.UserSelect;

type SafeUserRow = Prisma.UserGetPayload<{ select: typeof USER_SAFE_SELECT }>;

/** Flattens the UserRole join rows into a plain `roles` array — passwordHash never enters this shape at all (5.4/SEC-030). */
function shapeUser(user: SafeUserRow) {
  const { roles, ...rest } = user;
  return { ...rest, roles: roles.map((r) => r.role) };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(query: ListUsersQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.UserWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.roleCode ? { roles: { some: { role: { code: query.roleCode } } } } : {}),
      ...(query.search
        ? {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      tx.user.findMany({
        where,
        select: USER_SAFE_SELECT,
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.user.count({ where }),
    ]);

    return paginate(data.map(shapeUser), total, query.page, query.pageSize);
  }

  async getById(id: string) {
    const tx = this.tenantPrisma.client;
    const user = await tx.user.findUnique({ where: { id }, select: USER_SAFE_SELECT });
    if (!user) throw new UserNotFoundException();
    return shapeUser(user);
  }

  /** Only system roles (4.1: MVP has no custom-role UI, [v1.1]) can be assigned. */
  private async resolveRoleIds(tx: TenantClient, roleCodes: string[]): Promise<string[]> {
    const roles = await tx.role.findMany({ where: { code: { in: roleCodes }, isSystem: true } });
    const found = new Set(roles.map((r) => r.code));
    const missing = roleCodes.filter((code) => !found.has(code));
    if (missing.length > 0) throw new InvalidRoleCodesException(missing);
    return roles.map((r) => r.id);
  }

  /**
   * SEC-020..024 ("privilege escalation imkonsiz"): granting OWNER isn't
   * gated by a role/permission hierarchy anywhere else in this codebase
   * (permissions are flat sets, not ranked), so this is a targeted guard
   * for the one role whose grant ('ALL' permissions, seed.ts) is
   * unambiguously more powerful than everything else — only an existing
   * OWNER may hand it out. Without this, `users.update` (also granted to
   * SALES_DIRECTOR, seed.ts ROLE_PERMISSIONS) would let a non-owner
   * self-promote by PATCHing their own roleCodes to include OWNER.
   */
  private assertCanGrantRoles(roleCodes: string[], actor: AuthenticatedUser): void {
    if (roleCodes.includes('OWNER') && !actor.roles.includes('OWNER')) {
      throw new CannotGrantOwnerRoleException();
    }
  }

  /** True if `userId` currently holds OWNER and no other active user in the tenant does — i.e. removing/demoting them would leave the company with no OWNER at all. */
  private async wouldRemoveLastOwner(tx: TenantClient, userId: string): Promise<boolean> {
    const hasOwnerRole = await tx.userRole.findFirst({ where: { userId, role: { code: 'OWNER' } } });
    if (!hasOwnerRole) return false;

    const otherActiveOwners = await tx.user.count({
      where: { isActive: true, NOT: { id: userId }, roles: { some: { role: { code: 'OWNER' } } } },
    });
    return otherActiveOwners === 0;
  }

  async create(dto: CreateUserDto, actor: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    this.assertCanGrantRoles(dto.roleCodes, actor);

    const clash = await tx.user.findFirst({ where: { phone: dto.phone } });
    if (clash) throw new DuplicateUserPhoneException(dto.phone);

    const roleIds = await this.resolveRoleIds(tx, dto.roleCodes);
    const passwordHash = dto.password ? await argon2.hash(dto.password, { type: argon2.argon2id }) : undefined;

    let user;
    try {
      user = await tx.user.create({
        data: {
          companyId: actor.companyId,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          email: dto.email,
          passwordHash,
          roles: { create: roleIds.map((roleId) => ({ roleId })) },
        },
        select: USER_SAFE_SELECT,
      });
    } catch (err) {
      // The findFirst above is only a fast path — @@unique([companyId, phone])
      // is the real guard against two concurrent creates racing past it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new DuplicateUserPhoneException(dto.phone);
      }
      throw err;
    }
    const shaped = shapeUser(user);

    await this.auditLog.log(tx, {
      companyId: actor.companyId,
      userId: actor.id,
      action: 'user.create',
      entity: 'User',
      entityId: user.id,
      newValue: toAuditJson(shaped),
    });

    return shaped;
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.user.findUnique({ where: { id }, select: USER_SAFE_SELECT });
    if (!before) throw new UserNotFoundException();

    if (dto.phone && dto.phone !== before.phone) {
      const clash = await tx.user.findFirst({ where: { phone: dto.phone, NOT: { id } } });
      if (clash) throw new DuplicateUserPhoneException(dto.phone);
    }

    if (dto.roleCodes) {
      this.assertCanGrantRoles(dto.roleCodes, actor);
      if (!dto.roleCodes.includes('OWNER') && (await this.wouldRemoveLastOwner(tx, id))) {
        throw new LastOwnerException();
      }

      const roleIds = await this.resolveRoleIds(tx, dto.roleCodes);
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: id, roleId })) });
    }

    if (dto.password && id !== actor.id && !actor.roles.includes('OWNER')) {
      // `users.update` alone isn't enough to reset someone else's password —
      // SALES_DIRECTOR holds it, and that would be a takeover of an OWNER account.
      throw new CannotSetOthersPasswordException();
    }

    const passwordHash = dto.password ? await argon2.hash(dto.password, { type: argon2.argon2id }) : undefined;

    let user;
    try {
      user = await tx.user.update({
        where: { id },
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          email: dto.email,
          ...(passwordHash ? { passwordHash } : {}),
        },
        select: USER_SAFE_SELECT,
      });
    } catch (err) {
      // Same TOCTOU as create(): the findFirst above is only a fast path.
      if (dto.phone && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new DuplicateUserPhoneException(dto.phone);
      }
      throw err;
    }
    const shaped = shapeUser(user);

    await this.auditLog.log(tx, {
      companyId: actor.companyId,
      userId: actor.id,
      action: 'user.update',
      entity: 'User',
      entityId: id,
      oldValue: toAuditJson(shapeUser(before)),
      newValue: toAuditJson(shaped),
    });

    return shaped;
  }

  /** Also revokes every active session (15.2) — a deactivated account shouldn't keep working until its access token happens to expire. */
  async deactivate(id: string, actor: AuthenticatedUser) {
    if (id === actor.id) throw new CannotDeactivateSelfException();
    const tx = this.tenantPrisma.client;
    const before = await tx.user.findUnique({ where: { id } });
    if (!before) throw new UserNotFoundException();
    if (!before.isActive) throw new UserAlreadyInactiveException();
    if (await this.wouldRemoveLastOwner(tx, id)) throw new LastOwnerException();

    const user = await tx.user.update({ where: { id }, data: { isActive: false }, select: USER_SAFE_SELECT });
    await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    const shaped = shapeUser(user);

    await this.auditLog.log(tx, {
      companyId: actor.companyId,
      userId: actor.id,
      action: 'user.deactivate',
      entity: 'User',
      entityId: id,
      oldValue: toAuditJson({ isActive: true }),
      newValue: toAuditJson({ isActive: false }),
    });

    return shaped;
  }

  async activate(id: string, actor: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.user.findUnique({ where: { id } });
    if (!before) throw new UserNotFoundException();
    if (before.isActive) throw new UserAlreadyActiveException();

    const user = await tx.user.update({ where: { id }, data: { isActive: true }, select: USER_SAFE_SELECT });
    const shaped = shapeUser(user);

    await this.auditLog.log(tx, {
      companyId: actor.companyId,
      userId: actor.id,
      action: 'user.activate',
      entity: 'User',
      entityId: id,
      oldValue: toAuditJson({ isActive: false }),
      newValue: toAuditJson({ isActive: true }),
    });

    return shaped;
  }
}
