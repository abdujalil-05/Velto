import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
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
import { buildTestWorkbook } from '../src/modules/import/parsers/test-workbook';
import { uniquePhone } from './unique-phone';
import { loginWithMfa } from './mfa-login';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MB = 1024 * 1024;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

class InMemoryStorage {
  readonly files = new Map<string, Buffer>();
  async upload(input: { buffer: Buffer; extension: string; keyPrefix: string }) {
    const key = `memory://${input.keyPrefix}/${randomUUID()}.${input.extension}`;
    this.files.set(key, input.buffer);
    return key;
  }
}

/** Dependency-bump regression (multer 2.5, body-parser 1.20.9): upload/import/JSON-body behaviour over real HTTP. SEC-040..048, M12. */
describe('E2E upload & body hardening (multer/body-parser bump)', () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let app: INestApplication;
  let port: number;
  const storage = new InMemoryStorage();
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tag = randomUUID().slice(0, 6);
  let companyA: string;
  let companyB: string;
  let ownerA: { token: string };
  let ownerB: { token: string };
  let productId: string;

  const http = () => request(app.getHttpServer());
  const bearer = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });

  async function seedUser(companyId: string, roleCode: string) {
    const phone = uniquePhone();
    const permissionIds: string[] = [];
    for (const key of permissionKeysForRole(roleCode)) {
      const [module, code] = key.split('.');
      const p = await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } });
      permissionIds.push(p.id);
    }
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: roleCode, lastName: 'T', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
      for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    const body = await loginWithMfa(app, phone, password);
    return { token: body.accessToken as string };
  }

  async function seedCompany(label: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-uph-${label}-${Date.now()}-${tag}`, name: `UPH ${label}` } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `UPH ${label}` } })).id;
  }

  /** Raw TCP request: lets us send broken multipart / truncated bodies that supertest would refuse to build. */
  function raw(head: string, body: Buffer | string, opts: { destroyAfterWrite?: boolean; contentLength?: number } = {}) {
    return new Promise<string>((resolve) => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const sock = net.connect(port, '127.0.0.1');
      let out = '';
      sock.on('data', (d) => (out += d.toString('latin1')));
      sock.on('close', () => resolve(out));
      sock.on('error', () => resolve(out));
      sock.setTimeout(8000, () => sock.destroy());
      sock.write(`${head}Content-Length: ${opts.contentLength ?? b.length}\r\nConnection: close\r\n\r\n`);
      sock.write(b);
      if (opts.destroyAfterWrite) setTimeout(() => sock.destroy(), 100);
    });
  }
  const statusOf = (resp: string) => Number(/^HTTP\/1\.1 (\d{3})/.exec(resp)?.[1] ?? 0);
  const healthy = async () => {
    const res = await http().get('/import').set(bearer(ownerA));
    expect(res.status).toBe(200);
  };
  const imageUp = (buf: Buffer, filename = 'p.png', contentType = 'image/png', field = 'image') =>
    http().post(`/products/${productId}/image`).set(bearer(ownerA)).attach(field, buf, { filename, contentType });
  const importUp = (who: { token: string }, buf: Buffer, filename = 'x.xlsx', contentType = XLSX) =>
    http().post('/import/customers').set(bearer(who)).attach('file', buf, { filename, contentType });
  const obUp = (who: { token: string }, buf: Buffer, filename = 'o.xlsx', contentType = XLSX) =>
    http().post('/opening-balances/customers/preview').set(bearer(who)).attach('file', buf, { filename, contentType });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(storage).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as net.AddressInfo).port;
    companyA = await seedCompany('A');
    companyB = await seedCompany('B');
    ownerA = await seedUser(companyA, 'OWNER');
    ownerB = await seedUser(companyB, 'OWNER');
    productId = (
      await tenantPrisma.run(companyA, (tx) => tx.product.create({ data: { companyId: companyA, sku: `UPH-${tag}`, name: 'UPH', baseUnit: 'dona', vatRate: '12' } }))
    ).id;
  });
  afterAll(async () => {
    await app.close();
  });

  describe('product image (SEC-040..048)', () => {
    it('valid PNG -> 201 and stored', async () => {
      const res = await imageUp(PNG);
      expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBeLessThan(300);
      expect([...storage.files.values()].some((b) => b.equals(PNG))).toBe(true);
    });
    it('> 5 MB -> 413 (multer LIMIT_FILE_SIZE), never 500', async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(5 * MB + 10, 2)]);
      const res = await imageUp(big);
      expect([400, 413, 422]).toContain(res.status);
      await healthy();
    });
    it('text / exe disguised as image/png -> rejected 4xx (magic bytes)', async () => {
      const txt = await imageUp(Buffer.from('hello not an image, just text'), 'a.png', 'image/png');
      expect(txt.status).toBeGreaterThanOrEqual(400);
      expect(txt.status).toBeLessThan(500);
      const exe = await imageUp(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]), 'a.png', 'image/png');
      expect(exe.status).toBeGreaterThanOrEqual(400);
      expect(exe.status).toBeLessThan(500);
    });
    it('missing file -> 4xx; wrong field name -> 4xx (not 500)', async () => {
      const none = await http().post(`/products/${productId}/image`).set(bearer(ownerA));
      expect(none.status).toBeGreaterThanOrEqual(400);
      expect(none.status).toBeLessThan(500);
      const wrong = await imageUp(PNG, 'p.png', 'image/png', 'other');
      expect(wrong.status).toBeGreaterThanOrEqual(400);
      expect(wrong.status).toBeLessThan(500);
    });
    it('malformed multipart (bad boundary / truncated body) -> 4xx, server stays healthy', async () => {
      const auth = `Authorization: Bearer ${ownerA.token}\r\n`;
      const head = (ct: string) => `POST /products/${productId}/image HTTP/1.1\r\nHost: x\r\n${auth}Content-Type: ${ct}\r\n`;
      const badBoundary = await raw(head('multipart/form-data'), 'garbage');
      expect(statusOf(badBoundary)).toBeGreaterThanOrEqual(400);
      expect(statusOf(badBoundary)).toBeLessThan(500);
      const wrongBoundary = await raw(head('multipart/form-data; boundary=XYZ'), '--ABC\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n\r\nxx\r\n--ABC--\r\n');
      expect(statusOf(wrongBoundary)).toBeGreaterThanOrEqual(400);
      expect(statusOf(wrongBoundary)).toBeLessThan(500);
      const trunc = await raw(head('multipart/form-data; boundary=XYZ'), '--XYZ\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n' + 'abc');
      expect(statusOf(trunc)).toBeGreaterThanOrEqual(400);
      expect(statusOf(trunc)).toBeLessThan(500);
      await healthy();
    });
    it('client aborting mid-upload: no hang, no crash', async () => {
      const auth = `Authorization: Bearer ${ownerA.token}\r\n`;
      const head = `POST /products/${productId}/image HTTP/1.1\r\nHost: x\r\n${auth}Content-Type: multipart/form-data; boundary=XYZ\r\n`;
      const part = '--XYZ\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n';
      await raw(head, part + 'abc', { destroyAfterWrite: true, contentLength: 5 * MB });
      await healthy();
    });
    it('cross-tenant: tenant B cannot set image on tenant A product -> 404', async () => {
      const res = await http().post(`/products/${productId}/image`).set(bearer(ownerB)).attach('image', PNG, { filename: 'p.png', contentType: 'image/png' });
      expect(res.status).toBe(404);
    });
  });

  describe('import + opening balances (M12, 10 MB limits)', () => {
    it('import > 10 MB -> 413/4xx, no job created, healthy', async () => {
      const before = (await http().get('/import').set(bearer(ownerA))).body.data.length;
      const res = await importUp(ownerA, Buffer.alloc(10 * MB + 1024, 7));
      expect([400, 413, 422]).toContain(res.status);
      expect((await http().get('/import').set(bearer(ownerA))).body.data.length).toBe(before);
    });
    it('opening-balances > 10 MB -> 413/4xx', async () => {
      const res = await obUp(ownerA, Buffer.alloc(10 * MB + 1024, 7));
      expect([400, 413, 422]).toContain(res.status);
      await healthy();
    });
    it('malformed / non-workbook file -> 4xx for import and opening balances', async () => {
      const junk = Buffer.from('this is not a zip nor csv\x00\x01\x02');
      const a = await importUp(ownerA, junk);
      expect(a.status).toBeGreaterThanOrEqual(400);
      expect(a.status).toBeLessThan(500);
      const b = await obUp(ownerA, junk);
      expect(b.status).toBeGreaterThanOrEqual(400);
      expect(b.status).toBeLessThan(500);
    });
    it('missing file -> 4xx for import and opening balances', async () => {
      for (const path of ['/import/customers', '/opening-balances/customers/preview']) {
        const res = await http().post(path).set(bearer(ownerA));
        expect(res.status, path).toBeGreaterThanOrEqual(400);
        expect(res.status, path).toBeLessThan(500);
      }
    });
    it('malformed multipart on import -> 4xx, healthy', async () => {
      const resp = await raw(`POST /import/customers HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${ownerA.token}\r\nContent-Type: multipart/form-data; boundary=XYZ\r\n`, '--XYZ\r\nContent-Disposition: form-data; name="file"; filename="a.xlsx"\r\n\r\nabc');
      expect(statusOf(resp)).toBeGreaterThanOrEqual(400);
      expect(statusOf(resp)).toBeLessThan(500);
      await healthy();
    });
    it('Excel import preview creates job; cross-tenant job read/confirm -> 404', async () => {
      const buf = await buildTestWorkbook(['code', 'name', 'phone', 'paymentTermDays', 'outletName'], [[`UH${tag}-1`, 'C', '+998901234567', 7, 'O']]);
      const up = await importUp(ownerA, buf);
      expect(up.status, JSON.stringify(up.body).slice(0, 200)).toBe(201);
      await http().get(`/import/${up.body.id}`).set(bearer(ownerB)).expect(404);
      await http().post(`/import/${up.body.id}/confirm`).set(bearer(ownerB)).expect(404);
    });
    it('opening-balances: tenant B cannot read/post another tenant batch -> 404', async () => {
      await tenantPrisma.run(companyA, (tx) => tx.customer.create({ data: { companyId: companyA, code: `OBH${tag}`, name: 'C' } }));
      const csv = Buffer.from(`customerCode;debt;credit;docRef;docDate\nOBH${tag};10.00;;R1;01.09.2026\n`, 'utf-8');
      const up = await obUp(ownerA, csv, 'o.csv', 'text/csv');
      expect(up.status, JSON.stringify(up.body).slice(0, 200)).toBe(201);
      const id = up.body.batch.id;
      await http().get(`/opening-balances/${id}`).set(bearer(ownerB)).expect(404);
      await http().post(`/opening-balances/${id}/post`).set(bearer(ownerB)).send({ asOfDate: '2026-09-01', source: '1C', controlDebt: '0', controlCredit: '0', controlQty: '0', signOff: true }).expect(404);
    });
  });

  describe('JSON body (body-parser 1.20.9)', () => {
    it('malformed JSON -> 400 trilingual contract', async () => {
      const res = await http().post('/auth/login').set('Content-Type', 'application/json').send('{"phone": ');
      expect(res.status).toBe(400);
      expect(res.body.code).toBeTruthy();
      expect(res.body.message).toEqual(expect.objectContaining({ uz: expect.any(String), ru: expect.any(String), en: expect.any(String) }));
    });
    const gzPost = (body: Buffer) =>
      raw('POST /auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\n', body);
    const payload = Buffer.from('{"phone":"x","password":"y"}');
    it('control: valid gzip body is decoded (not 500)', async () => {
      expect(statusOf(await gzPost(gzipSync(payload)))).toBeLessThan(500);
    });
    it('gzip body with trailing bytes -> 4xx, not 500 (GHSA-27r3)', async () => {
      const st = statusOf(await gzPost(Buffer.concat([gzipSync(payload), Buffer.from('TRAILING-GARBAGE')])));
      expect(st).toBeGreaterThanOrEqual(400);
      expect(st).toBeLessThan(500);
      await healthy();
    });
    it('truncated / corrupt gzip body -> 4xx, not 500', async () => {
      const gz = gzipSync(payload);
      for (const bad of [gz.subarray(0, gz.length - 6), Buffer.from('not gzip at all')]) {
        const st = statusOf(await gzPost(bad));
        expect(st).toBeGreaterThanOrEqual(400);
        expect(st).toBeLessThan(500);
      }
    });
  });
});
