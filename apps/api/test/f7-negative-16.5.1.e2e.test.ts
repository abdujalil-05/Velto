import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { StorageService } from '../src/common/storage/storage.service';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { SalesService } from '../src/modules/sales/sales.service';
import { uniquePhone } from './unique-phone';

/**
 * TZ v5.0 §16.5.1 worked negative checklist (code-testable items), real Postgres + RLS:
 *  (1) role removed while offline  (2) cancel after confirm releases once  (3) export download after access loss.
 */
describe('E2E §16.5.1 negative checklist', () => {
  vi.setConfig({ testTimeout: 30_000 });
  let app: INestApplication;
  let sales: SalesService;
  let cid: string;
  let productA: string;
  let productB: string;
  let packA: string;
  let packB: string;
  let warehouseId: string;
  let customerId: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, { token: string; userId: string }> = {};
  const auth = (k: string) => ({ Authorization: `Bearer ${tokens[k]!.token}` });
  const http = () => request(app.getHttpServer());
  const run = <T>(fn: () => Promise<T>) => tenantPrisma.run(cid, fn);
  const rid = () => randomUUID().slice(0, 8);
  const FILE = Buffer.from('code,amount\r\nP-1,100\r\n');
  const HASH = createHash('sha256').update(FILE).digest('hex');
  const storageDouble = { getObject: async () => ({ stream: Readable.from([FILE]), size: FILE.length }) };
  const roleIds: Record<string, string> = {};

  async function mkUser(key: string, roleCode: string) {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId: cid, firstName: key, lastName: 'F7Neg', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${cid}, true)`;
      await tx.userRole.create({ data: { userId: user.id, roleId: roleIds[roleCode]! } });
    });
    const res = await http().post('/auth/login').send({ phone, password }).expect(201);
    tokens[key] = { token: res.body.accessToken, userId: user.id };
  }
  const removeRoles = (userId: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${cid}, true)`;
      await tx.userRole.deleteMany({ where: { userId } });
    });
  const grantRole = (userId: string, roleCode: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${cid}, true)`;
      await tx.userRole.create({ data: { userId, roleId: roleIds[roleCode]! } });
    });
  const deniedAudits = (userId: string) =>
    run(() => tenantPrisma.client.auditLog.count({ where: { action: 'auth.permission_denied', userId } }));
  const level = (productId: string) =>
    run(async () => tenantPrisma.client.stockLevel.findFirstOrThrow({ where: { productId, warehouseId } }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(storageDouble).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');
    sales = app.get(SalesService);

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-f7neg-${Date.now()}-${rid()}`, name: 'F7Neg' } });
    cid = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'F7Neg' } })).id;
    for (const roleCode of ['SALES_AGENT', 'OWNER', 'ACCOUNTANT']) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const [module, code] = key.split('.');
        permissionIds.push((await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })).id);
      }
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${cid}, true)`;
        const role = await tx.role.create({ data: { companyId: cid, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
        roleIds[roleCode] = role.id;
      });
    }
    await run(async () => {
      const tx = tenantPrisma.client;
      warehouseId = (await tx.warehouse.create({ data: { companyId: cid, name: 'F7Neg WH' } })).id;
      const pl = await tx.priceList.create({ data: { companyId: cid, name: 'Default', isDefault: true } });
      const mk = async (tag: string) => {
        const p = await tx.product.create({ data: { companyId: cid, sku: `F7N-${tag}-${rid()}`, name: `F7N ${tag}`, baseUnit: 'dona', vatRate: 12 } });
        const pk = await tx.productPackaging.create({ data: { productId: p.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true } });
        await tx.priceListItem.create({ data: { priceListId: pl.id, productId: p.id, price: '10000' } });
        await tx.stockLevel.create({ data: { productId: p.id, warehouseId, onHand: 1000 } });
        return { productId: p.id, packagingId: pk.id };
      };
      ({ productId: productA, packagingId: packA } = await mk('A'));
      ({ productId: productB, packagingId: packB } = await mk('B'));
      customerId = (await tx.customer.create({ data: { companyId: cid, code: `F7N-C-${rid()}`, name: 'C' } })).id;
    });
    await mkUser('AGENT', 'SALES_AGENT');
    await mkUser('OWNER', 'OWNER');
    await mkUser('ACCOUNTANT', 'ACCOUNTANT');
    await mkUser('ACCOUNTANT2', 'ACCOUNTANT');
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('§16.5.1 role removed while offline: next push => 403 + audit, nothing written (also for an already-ACKed clientId); accepted order stays; re-grant => queued doc is accepted, not lost', async () => {
    const mkDoc = () => {
      const clientId = randomUUID();
      return { type: 'order', clientId, payload: { customerId, clientId, lines: [{ productId: productA, packagingId: packA, qty: 1, expectedUnitPrice: '10000' }] } };
    };
    const push = (docs: unknown[]) => http().post('/sync/push').set(auth('AGENT')).send({ documents: docs });
    const byClient = (id: string) => run(() => tenantPrisma.client.salesOrder.findMany({ where: { clientId: id } }));
    const soCounter = () =>
      run(async () => (await tenantPrisma.client.documentCounter.findFirst({ where: { docType: 'SO', year: new Date().getFullYear() } }))?.lastNumber ?? 0);

    const accepted = mkDoc();
    const ok = await push([accepted]).expect(201);
    expect(ok.body.results[0].status).toBe('ACCEPTED');
    const [acceptedOrder] = await byClient(accepted.clientId);
    expect(acceptedOrder).toBeDefined();
    const orderAudits = () => run(() => tenantPrisma.client.auditLog.count({ where: { entityId: acceptedOrder!.id } }));
    const auditsBefore = await orderAudits();
    expect(auditsBefore).toBeGreaterThan(0);

    await removeRoles(tokens.AGENT!.userId); // admin removes the role while the agent is offline
    const deniedBefore = await deniedAudits(tokens.AGENT!.userId);
    const counter = await soCounter();
    const queued = mkDoc();
    await push([queued]).expect(403);
    await push([accepted]).expect(403); // replay of an ACKed doc is denied too, not answered DUPLICATE
    expect(await byClient(queued.clientId)).toHaveLength(0);
    expect(await byClient(accepted.clientId)).toHaveLength(1);
    expect(await soCounter()).toBe(counter);
    expect(await deniedAudits(tokens.AGENT!.userId)).toBe(deniedBefore + 2);
    expect(await orderAudits()).toBe(auditsBefore); // history of the accepted mutation is untouched

    await grantRole(tokens.AGENT!.userId, 'SALES_AGENT'); // access restored; the very same queued doc goes through
    const after = await push([queued, accepted]).expect(201);
    expect(after.body.results.map((r: { status: string }) => r.status)).toEqual(['ACCEPTED', 'DUPLICATE']);
    expect(await byClient(queued.clientId)).toHaveLength(1);
    expect(await byClient(accepted.clientId)).toHaveLength(1);
  });

  it('§16.5.1 cancel after confirm: 4 parallel cancels (distinct keys) => exactly one wins, one RELEASE per line, reserved back to baseline, onHand untouched, no ISSUE', async () => {
    const [baseA, baseB] = [await level(productA), await level(productB)];
    const order = await run(() =>
      sales.create(
        {
          customerId,
          lines: [
            { productId: productA, packagingId: packA, qty: 3 },
            { productId: productB, packagingId: packB, qty: 5 },
          ],
        },
        { id: tokens.OWNER!.userId, companyId: cid, roles: ['OWNER'] } as never,
      ),
    );
    await http().post(`/orders/${order.id}/confirm`).set(auth('OWNER')).set('Idempotency-Key', randomUUID()).expect(201);
    expect((await level(productA)).reserved.minus(baseA.reserved).toString()).toBe('3');
    expect((await level(productB)).reserved.minus(baseB.reserved).toString()).toBe('5');

    const res = await Promise.all(
      Array.from({ length: 4 }, () =>
        http().post(`/orders/${order.id}/cancel`).set(auth('OWNER')).set('Idempotency-Key', randomUUID()).send({ reason: 'dup cancel race' }),
      ),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of res.filter((x) => x.status !== 201)) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }

    const moves = await run(() => tenantPrisma.client.stockMovement.findMany({ where: { refType: 'SalesOrder', refId: order.id } }));
    const by = (t: string) => moves.filter((m) => m.type === t);
    expect(by('RELEASE')).toHaveLength(2);
    expect(by('RELEASE').map((m) => `${m.productId}:${m.qty.toString()}`).sort()).toEqual([`${productA}:3`, `${productB}:5`].sort());
    expect(by('ISSUE')).toHaveLength(0);
    for (const [p, base] of [[productA, baseA], [productB, baseB]] as const) {
      const now = await level(p);
      expect(now.reserved.toString()).toBe(base.reserved.toString());
      expect(now.onHand.toString()).toBe(base.onHand.toString());
    }
    expect((await run(() => tenantPrisma.client.salesOrder.findUniqueOrThrow({ where: { id: order.id } }))).status).toBe('CANCELLED');
    expect(await run(() => tenantPrisma.client.auditLog.count({ where: { action: 'order.cancel', entityId: order.id } }))).toBe(1);

    // a later, sequential cancel is a rejected transition and changes nothing
    const again = await http().post(`/orders/${order.id}/cancel`).set(auth('OWNER')).set('Idempotency-Key', randomUUID()).send({ reason: 'again' });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect((await level(productA)).reserved.toString()).toBe(baseA.reserved.toString());
    expect((await run(() => tenantPrisma.client.stockMovement.count({ where: { refType: 'SalesOrder', refId: order.id, type: 'RELEASE' } })))).toBe(2);
  });

  it('§16.5.1 export download: permission removed after login => the SAME unexpired JWT is denied (403 + audit); deactivated user => 401', async () => {
    const newJob = () =>
      run(async () => {
        const tx = tenantPrisma.client;
        const day = new Date(Date.UTC(2019, 0, 1 + Math.floor(Math.random() * 3000)));
        const job = await tx.exportJob.create({
          data: { companyId: cid, type: '1c', format: 'CSV', periodFrom: day, periodTo: new Date(day.getTime() + 86_399_000), status: 'QUEUED' },
        });
        await tx.exportJob.update({ where: { id: job.id }, data: { status: 'PROCESSING' } });
        return tx.exportJob.update({
          where: { id: job.id },
          data: { status: 'GENERATED', fileHash: HASH, storageKey: `exports/${cid}/${job.id}.csv`, fileName: 'x.csv', fileSize: FILE.length, recordCount: 1, mappingVersion: 1, generatedAt: new Date() },
        });
      });
    const job = await newJob();
    const dl = (k: string) => http().get(`/export/1c/${job.id}/download`).set(auth(k));

    await dl('ACCOUNTANT').expect(200); // precondition: allowed while the role is held
    await removeRoles(tokens.ACCOUNTANT!.userId);
    const denied = await deniedAudits(tokens.ACCOUNTANT!.userId);
    const res = await dl('ACCOUNTANT').expect(403);
    expect(res.body.code).toBeDefined();
    expect(await deniedAudits(tokens.ACCOUNTANT!.userId)).toBe(denied + 1);
    await grantRole(tokens.ACCOUNTANT!.userId, 'ACCOUNTANT');
    await dl('ACCOUNTANT').expect(200); // permission is re-read per request, not cached in the token

    await dl('ACCOUNTANT2').expect(200);
    await systemPrisma.user.update({ where: { id: tokens.ACCOUNTANT2!.userId }, data: { isActive: false } });
    await dl('ACCOUNTANT2').expect(401);
  });
});
