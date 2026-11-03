import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { Controller, Get, Injectable, type INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { prisma, systemPrisma } from '@velto/database';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { CurrentUser } from '../src/common/decorators/current-user.decorator';
import { RequirePermission } from '../src/common/decorators/require-permission.decorator';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { TenantTx } from '../src/common/tenant/tenant-tx-options.decorator';
import type { AuthenticatedUser } from '../src/common/auth/auth.types';
import { uniquePhone } from './unique-phone';
import { loginWithMfa } from './mfa-login';

const caught = async (fn: () => unknown) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

/** Test-only controller proving @TenantTx({ scope: 'handler' }); not part of AppModule. */
@Injectable()
@Controller('_th')
class HandlerScopeTestController {
  constructor(private readonly tp: TenantPrismaService) {}

  @Get('ok')
  @RequirePermission('customers.read')
  @TenantTx({ scope: 'handler' })
  async ok(@CurrentUser() user: AuthenticatedUser) {
    const txActive = TenantContext.peek()?.txActive;
    const clientErr = await caught(() => TenantContext.client);
    const bareErr = await caught(() => this.tp.client);
    const afterCommitErr = await caught(() => TenantContext.afterCommit(() => undefined));
    const names = await this.tp.run(user.companyId, (tx) => tx.customer.findMany({ select: { name: true } }));
    return { txActive, clientErr, bareErr, afterCommitErr, userId: user.id, companyId: user.companyId, names: names.map((n) => n.name) };
  }

  @Get('nested')
  @RequirePermission('customers.read')
  @TenantTx({ scope: 'handler' })
  async nested(@CurrentUser() user: AuthenticatedUser) {
    const err = await this.tp.run(user.companyId, () => caught(() => this.tp.run(user.companyId, async () => 1)));
    return { err };
  }

  @Get('two')
  @RequirePermission('customers.read')
  @TenantTx({ scope: 'handler' })
  async two(@CurrentUser() user: AuthenticatedUser) {
    const log: string[] = [];
    await this.tp.run(user.companyId, async () => {
      TenantContext.afterCommit(() => void log.push('a1'));
    });
    await this.tp.run(user.companyId, async () => {
      TenantContext.afterCommit(() => void log.push('b1'));
    });
    log.push('end');
    return { log };
  }

  @Get('req')
  @RequirePermission('customers.read')
  async req() {
    return { ok: true };
  }

  @Get('short')
  @RequirePermission('customers.read')
  @TenantTx({ scope: 'handler' })
  async short(@CurrentUser() user: AuthenticatedUser) {
    await this.tp.run(user.companyId, (tx) => tx.$queryRaw`SELECT pg_sleep(0.05)::text`);
    return { ok: true };
  }
}

describe('E2E F7: @TenantTx({ scope: "handler" })', () => {
  let app: INestApplication;
  const tp = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const names = { A: `TH-A-${Date.now()}`, B: `TH-B-${Date.now()}` };
  let companyA: string;
  let ownerA: string;
  let tokOwner: string;
  let tokNoPerm: string;
  let tokDeact: string;
  let deactUser: string;
  let companyC: string;
  let tokB: string;
  let tokC: string;

  async function mkCompany(label: string) {
    const t = await systemPrisma.tenant.create({ data: { slug: `test-th-${label}-${Date.now()}`, name: `TH ${label}` } });
    return (await systemPrisma.company.create({ data: { tenantId: t.id, name: `TH Co ${label}` } })).id;
  }
  async function mkUser(companyId: string, roleId: string, label: string) {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: label, lastName: 'Th', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      await tx.userRole.create({ data: { userId: user.id, roleId } });
    });
    const res = { body: await loginWithMfa(app, phone, password) };
    return { id: user.id, token: res.body.accessToken as string };
  }
  async function mkRole(companyId: string, code: string, withRead: boolean) {
    const perm = await systemPrisma.permission.upsert({
      where: { module_code: { module: 'customers', code: 'read' } },
      update: {},
      create: { module: 'customers', code: 'read' },
    });
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = await tx.role.create({ data: { companyId, code, name: code } });
      if (withRead) await tx.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      return role.id;
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: [HandlerScopeTestController] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');

    companyA = await mkCompany('a');
    const companyB = await mkCompany('b');
    const readA = await mkRole(companyA, 'TH_READ', true);
    const noneA = await mkRole(companyA, 'TH_NONE', false);
    const readB = await mkRole(companyB, 'TH_READ', true);
    const o = await mkUser(companyA, readA, 'Owner');
    ownerA = o.id;
    tokOwner = o.token;
    tokNoPerm = (await mkUser(companyA, noneA, 'None')).token;
    const d = await mkUser(companyA, readA, 'Deact');
    deactUser = d.id;
    tokDeact = d.token;
    tokB = (await mkUser(companyB, readB, 'OwnerB')).token;
    companyC = await mkCompany('c');
    tokC = (await mkUser(companyC, await mkRole(companyC, 'TH_READ', true), 'OwnerC')).token;
    await tp.run(companyA, (tx) => tx.customer.create({ data: { companyId: companyA, code: 'TH-A', name: names.A } }));
    await tp.run(companyB, (tx) => tx.customer.create({ data: { companyId: companyB, code: 'TH-B', name: names.B } }));
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, token: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

  it('permitted: handler runs with no open tx, client access is fail-closed, own tenant only', async () => {
    const res = await get('/_th/ok', tokOwner).expect(200);
    expect(res.body.txActive).toBe(false);
    expect(res.body.clientErr).toMatch(/No open tenant transaction/);
    expect(res.body.bareErr).toMatch(/No open tenant transaction/);
    expect(res.body.afterCommitErr).toMatch(/No open tenant transaction/);
    expect(res.body.userId).toBe(ownerA);
    expect(res.body.companyId).toBe(companyA);
    expect(res.body.names).toContain(names.A);
    expect(res.body.names).not.toContain(names.B);
  });

  it('denied: 403 + auth.permission_denied audit (handler not invoked)', async () => {
    const traceId = `trace-th-${Date.now()}`;
    await get('/_th/ok', tokNoPerm).set('x-request-id', traceId).expect(403);
    const rows = await tp.run(companyA, (tx) => tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.newValue).toMatchObject({ permission: 'customers.read', method: 'GET' });
  });

  it('nested tenantPrisma.run throws in test/dev', async () => {
    const res = await get('/_th/nested', tokOwner).expect(200);
    expect(res.body.err).toMatch(/nested tenantPrisma\.run/);
  });

  it('sequential runs have independent afterCommit lists', async () => {
    const res = await get('/_th/two', tokOwner).expect(200);
    expect(res.body.log).toEqual(['a1', 'b1', 'end']);
  });

  it('40 parallel handler-scope requests: no deadlock / P2024', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => get('/_th/short', tokOwner)));
    expect(results.map((r) => r.status)).toEqual(Array(40).fill(200));
  });

  it('deactivated user -> 401', async () => {
    await get('/_th/short', tokDeact).expect(200);
    await systemPrisma.user.update({ where: { id: deactUser }, data: { isActive: false } });
    await get('/_th/short', tokDeact).expect(401);
  });

  it('deactivated company: existing access token -> 401 on request AND handler scope; other tenant unaffected', async () => {
    await get('/_th/req', tokC).expect(200);
    await get('/_th/short', tokC).expect(200);
    await systemPrisma.company.update({ where: { id: companyC }, data: { isActive: false } });
    await get('/_th/req', tokC).expect(401);
    await get('/_th/short', tokC).expect(401);
    await get('/_th/req', tokB).expect(200);
    await get('/_th/short', tokB).expect(200);
  });
});
