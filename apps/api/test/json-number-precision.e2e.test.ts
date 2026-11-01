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
import { uniquePhone } from './unique-phone';
import { loginWithMfa } from './mfa-login';

/** ADR-059: raw JSON money literals through the real body parser into Decimal(18,2). */
describe('E2E ADR-059: JSON number precision (body-parser reviver)', () => {
  let app: INestApplication;
  let companyId: string;
  let customerId: string;
  let token: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const rid = () => randomUUID().slice(0, 8);

  /** Sends the literal text verbatim (no JS number in between). */
  const postRaw = (amountLiteral: string) =>
    request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'application/json')
      .send(`{"customerId":"${customerId}","amount":${amountLiteral},"method":"TRANSFER"}`);

  const stored = async (id: string) =>
    (await tenantPrisma.run(companyId, (tx) => tx.$queryRaw<{ a: string }[]>`SELECT amount::text AS a FROM "Payment" WHERE id = ${id}::uuid`))[0]!.a;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-adr059-${Date.now()}-${rid()}`, name: 'ADR059' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'ADR059' } })).id;
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: 'O', lastName: 'Adr059', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    const permissionIds: string[] = [];
    for (const k of permissionKeysForRole('OWNER')) {
      const [module, code] = k.split('.');
      permissionIds.push((await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })).id);
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = await tx.role.create({ data: { companyId, code: 'OWNER', name: 'OWNER', isSystem: true } });
      for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    token = (await loginWithMfa(app, phone, password)).accessToken;
    customerId = (await tenantPrisma.run(companyId, (tx) => tx.customer.create({ data: { companyId, code: `A-${rid()}`, name: 'Adr059' } }))).id;
  });

  afterAll(async () => {
    await app.close();
  });

  const accepted: Array<[string, string]> = [
    ['0.01', '0.01'],
    ['100.01', '100.01'],
    ['9007199254740.99', '9007199254740.99'],
    ['9999999999999.98', '9999999999999.98'],
    ['9999999999999.99', '9999999999999.99'],
  ];

  for (const [literal, expected] of accepted) {
    it(`accepts ${literal} exactly`, async () => {
      const res = await postRaw(literal).expect(201);
      expect(await stored(res.body.id)).toBe(expected);
    });
  }

  it('accepts an exactly-representable value >= 1e13 exactly (12345678901234.5)', async () => {
    const res = await postRaw('12345678901234.5').expect(201);
    expect(await stored(res.body.id)).toBe('12345678901234.50');
  });

  it('rejects 100.005 (scale) with 400', async () => {
    const res = await postRaw('100.005').expect(400);
    expect(JSON.stringify(res.body)).toContain('amount');
  });

  it('rejects 99999999999999.99 (would become ...98) with JSON_NUMBER_PRECISION_LOSS; nothing stored', async () => {
    const before = await tenantPrisma.run(companyId, (tx) => tx.payment.count());
    const res = await postRaw('99999999999999.99').expect(400);
    expect(res.body.code).toBe('JSON_NUMBER_PRECISION_LOSS');
    expect(res.body.message).toMatchObject({ uz: expect.any(String), ru: expect.any(String), en: expect.any(String) });
    expect(res.body.details).toMatchObject({ path: 'amount', value: '99999999999999.99' });
    expect(await tenantPrisma.run(companyId, (tx) => tx.payment.count())).toBe(before);
  });

  describe('exact decimal strings (ADR-059 follow-up)', () => {
    const postStr = (amount: string) => postRaw(JSON.stringify(amount));

    for (const [literal, expected] of [
      ['999999999999999.99', '999999999999999.99'],
      ['1000000000000000.00', '1000000000000000.00'],
      ['99999999999999.99', '99999999999999.99'],
      ['100.50', '100.50'],
    ]) {
      it(`persists "${literal}" exactly`, async () => {
        const res = await postStr(literal!).expect(201);
        expect(await stored(res.body.id)).toBe(expected);
      });
    }

    for (const bad of ['1000000000000000.01', '100.005', '1e5', '1,5', ' 1', '1 ', 'Infinity', 'NaN', '-5', '0', '0.00', '+1', '']) {
      it(`rejects "${bad}" with 400, nothing stored`, async () => {
        const before = await tenantPrisma.run(companyId, (tx) => tx.payment.count());
        await postStr(bad).expect(400);
        expect(await tenantPrisma.run(companyId, (tx) => tx.payment.count())).toBe(before);
      });
    }

    it('payments dedupe by clientId only (no @Idempotent on POST /payments): a queued numeric retry and its "100.5" form return the same payment', async () => {
      const clientId = randomUUID();
      const send = (amount: string) =>
        request(app.getHttpServer())
          .post('/payments')
          .set('Authorization', `Bearer ${token}`)
          .set('Content-Type', 'application/json')
          .send(`{"customerId":"${customerId}","amount":${amount},"method":"TRANSFER","clientId":"${clientId}"}`);
      const first = await send('100.5').expect(201);
      const replay = await send('100.5').expect(201);
      const asString = await send('"100.50"').expect(201);
      expect(replay.body.id).toBe(first.body.id);
      expect(asString.body.id).toBe(first.body.id);
      expect(await stored(first.body.id)).toBe('100.50');
    });

    it('10.4: same clientId with a different amount -> 409 PAYMENT_IDEMPOTENCY_CONFLICT (details = clientId only), nothing written', async () => {
      const clientId = randomUUID();
      const send = (amount: string) =>
        request(app.getHttpServer())
          .post('/payments')
          .set('Authorization', `Bearer ${token}`)
          .set('Content-Type', 'application/json')
          .send(`{"customerId":"${customerId}","amount":${amount},"method":"TRANSFER","clientId":"${clientId}"}`);
      const first = await send('"100.00"').expect(201);
      expect((await send('100').expect(201)).body.id).toBe(first.body.id);
      const before = await tenantPrisma.run(companyId, (tx) => tx.payment.count());
      const res = await send('"100.01"').expect(409);
      expect(res.body).toMatchObject({
        code: 'PAYMENT_IDEMPOTENCY_CONFLICT',
        message: { uz: expect.any(String), ru: expect.any(String), en: expect.any(String) },
      });
      expect(res.body.details).toEqual({ clientId });
      expect(await tenantPrisma.run(companyId, (tx) => tx.payment.count())).toBe(before);
    });
  });
});
