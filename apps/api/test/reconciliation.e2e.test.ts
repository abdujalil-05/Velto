import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { ReconciliationBusyException } from '../src/modules/reconciliation/reconciliation-exceptions';
import { ReconciliationAlertService } from '../src/modules/reconciliation/reconciliation-alert.service';
import { ReconciliationScheduleProcessor } from '../src/modules/reconciliation/reconciliation-schedule.processor';
import type { DetectResult, ReconciliationService } from '../src/modules/reconciliation/reconciliation.service';

/** F2.5: reconciliation API RBAC, manual run, fix, daily alert dedupe, scheduler isolation. */
describe('E2E F2.5: reconciliation', () => {
  let app: INestApplication;
  let companyId: string;
  let productId: string;
  let warehouseId: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, { token: string; userId: string }> = {};
  const auth = (r: string) => `Bearer ${tokens[r]!.token}`;

  const driftNotifications = (userId: string) =>
    tenantPrisma.run(companyId, (tx) =>
      tx.notification.count({ where: { recipientId: userId, type: 'reconciliation.drift' } }),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.init();

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-recon-e2e-${Date.now()}`, name: 'RECON' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'RECON Co' } })).id;

    for (const roleCode of ['OWNER', 'ACCOUNTANT', 'SALES_AGENT']) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const [module, code] = key.split('.');
        const p = await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } });
        permissionIds.push(p.id);
      }
      const phone = `+99890${Math.floor(1_000_000 + Math.random() * 8_000_000)}`;
      const user = await systemPrisma.user.create({
        data: { companyId, firstName: roleCode, lastName: 'Recon', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        const role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      });
      const res = await request(app.getHttpServer()).post('/auth/login').send({ phone, password }).expect(201);
      tokens[roleCode] = { token: res.body.accessToken, userId: user.id };
    }

    // Projection without ledger rows => STOCK drift.
    ({ productId, warehouseId } = await tenantPrisma.run(companyId, async (tx) => {
      const w = await tx.warehouse.create({ data: { companyId, name: 'W' } });
      const p = await tx.product.create({ data: { companyId, sku: `RE-${Date.now()}`, name: 'P', baseUnit: 'dona', vatRate: 12 } });
      await tx.stockLevel.create({ data: { productId: p.id, warehouseId: w.id, onHand: 5 } });
      return { productId: p.id, warehouseId: w.id };
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('SALES_AGENT has no access at all', async () => {
    await request(app.getHttpServer()).get('/reconciliation/runs').set('Authorization', auth('SALES_AGENT')).expect(403);
    await request(app.getHttpServer()).get('/reconciliation/findings').set('Authorization', auth('SALES_AGENT')).expect(403);
    await request(app.getHttpServer()).post('/reconciliation/run').set('Authorization', auth('SALES_AGENT')).expect(403);
  });

  it('ACCOUNTANT can read but not run/fix', async () => {
    await request(app.getHttpServer()).get('/reconciliation/runs').set('Authorization', auth('ACCOUNTANT')).expect(200);
    await request(app.getHttpServer()).get('/reconciliation/findings?status=OPEN&kind=STOCK').set('Authorization', auth('ACCOUNTANT')).expect(200);
    await request(app.getHttpServer()).post('/reconciliation/run').set('Authorization', auth('ACCOUNTANT')).expect(403);
    await request(app.getHttpServer()).post(`/reconciliation/findings/${randomUUID()}/fix`).set('Authorization', auth('ACCOUNTANT')).expect(403);
  });

  it('rejects invalid filter values', async () => {
    await request(app.getHttpServer()).get('/reconciliation/findings?status=BOGUS').set('Authorization', auth('OWNER')).expect(400);
  });

  it('OWNER manual run finds drift, alerts OWNER once (not ACCOUNTANT), second run same day sends no second alert', async () => {
    const res = await request(app.getHttpServer()).post('/reconciliation/run').set('Authorization', auth('OWNER')).set('Idempotency-Key', randomUUID()).expect(201);
    expect(res.body.stockFindings).toBe(1);
    const runs = await request(app.getHttpServer()).get('/reconciliation/runs').set('Authorization', auth('ACCOUNTANT')).expect(200);
    expect(runs.body.data[0]).toMatchObject({ trigger: 'MANUAL', triggeredById: tokens.OWNER!.userId });

    expect(await driftNotifications(tokens.OWNER!.userId)).toBe(1);
    expect(await driftNotifications(tokens.ACCOUNTANT!.userId)).toBe(0); // balance-only for accountant

    await request(app.getHttpServer()).post('/reconciliation/run').set('Authorization', auth('OWNER')).set('Idempotency-Key', randomUUID()).expect(201);
    expect(await driftNotifications(tokens.OWNER!.userId)).toBe(1);
  });

  it('OWNER fixes the finding; second fix => 409', async () => {
    const list = await request(app.getHttpServer()).get('/reconciliation/findings?status=OPEN&kind=STOCK').set('Authorization', auth('OWNER')).expect(200);
    const finding = list.body.data.find((f: { productId: string }) => f.productId === productId);
    expect(finding).toBeTruthy();
    const fixed = await request(app.getHttpServer()).post(`/reconciliation/findings/${finding.id}/fix`).set('Authorization', auth('OWNER')).set('Idempotency-Key', randomUUID()).expect(201);
    expect(fixed.body.outcome).toBe('FIXED');
    const level = await tenantPrisma.run(companyId, (tx) =>
      tx.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId, warehouseId } } }),
    );
    expect(level.onHand.toString()).toBe('0');
    await request(app.getHttpServer()).post(`/reconciliation/findings/${finding.id}/fix`).set('Authorization', auth('OWNER')).set('Idempotency-Key', randomUUID()).expect(409);
  });

  it('alert dedupe is per day: a new Tashkent day alerts again', async () => {
    const alerts = app.get(ReconciliationAlertService);
    const result = { runId: randomUUID(), stockFindings: 1, balanceFindings: 0 } as DetectResult;
    expect(await alerts.alertIfDrift(companyId, result)).toBe(0);
    expect(await alerts.alertIfDrift(companyId, result, new Date(Date.now() + 26 * 3600 * 1000))).toBe(1);
  });

  it('scheduler sweep: one company failing does not stop the others', async () => {
    const calls: string[] = [];
    let failId = '';
    const fake = {
      runDetection: async (id: string) => {
        calls.push(id);
        if (id === failId) throw new Error('boom');
        if (calls.length === 2) throw new ReconciliationBusyException();
        return { runId: randomUUID(), stockFindings: 0, balanceFindings: 0 } as DetectResult;
      },
    } as unknown as ReconciliationService;
    const all = await systemPrisma.company.findMany({ select: { id: true } });
    failId = all[0]!.id;
    const processor = new ReconciliationScheduleProcessor(fake, { alertIfDrift: async () => 0 } as unknown as ReconciliationAlertService);
    const out = await processor.runAll();
    expect(calls).toHaveLength(all.length);
    expect(out.failed).toBe(1);
    expect(out.ok + out.failed + out.busy).toBe(all.length);
  });
});
