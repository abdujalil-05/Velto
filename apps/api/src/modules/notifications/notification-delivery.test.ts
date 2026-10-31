import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { prisma, systemPrisma } from '@velto/database';
import { FakeBullQueue } from '../../common/queue/fake-bull-queue';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { TELEGRAM_LEASE_MS, TELEGRAM_MAX_ATTEMPTS, type NotificationDeliveryJobData } from './notification-delivery.constants';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationDeliverySweepService } from './notification-delivery-sweep.service';
import { NotificationsService } from './notifications.service';

const MSG = { uz: 'Salom', ru: 'Привет', en: 'Hello' };
const TOKEN = 'SECRET-BOT-TOKEN-123';

describe('Notification Telegram delivery pipeline (ADR-060, real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  // process.env may define TELEGRAM_BOT_TOKEN='' (which wins over ConfigService internal config), so stub get().
  const cfg = (token: string) => ({ get: () => token }) as unknown as ConfigService;
  const config = cfg(TOKEN);
  const delivery = new NotificationDeliveryService(tenantPrisma, config);
  let companyId: string;
  let otherCompanyId: string;
  let linkedId: string;
  let unlinkedId: string;
  let otherLinkedId: string;
  let tg = 1_000_000;

  beforeAll(async () => {
    const mk = async (label: string) => {
      const tenant = await systemPrisma.tenant.create({ data: { slug: `test-ntf-${label}-${randomUUID().slice(0, 8)}`, name: `Ntf ${label}` } });
      return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `Ntf Co ${label}` } })).id;
    };
    companyId = await mk('a');
    otherCompanyId = await mk('b');
    const user = (cid: string, label: string, telegramId?: bigint) =>
      systemPrisma.user.create({ data: { companyId: cid, firstName: label, lastName: 'T', phone: `+99893${Math.floor(1e6 + Math.random() * 8e6)}`, telegramId } }).then((u) => u.id);
    linkedId = await user(companyId, 'Linked', BigInt(++tg));
    unlinkedId = await user(companyId, 'Unlinked');
    otherLinkedId = await user(otherCompanyId, 'Other', BigInt(++tg));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.QUEUE_ENQUEUE_TIMEOUT_MS;
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const stubFetch = (impl: () => Promise<unknown>) => {
    const f = vi.fn(impl);
    vi.stubGlobal('fetch', f);
    return f;
  };
  const okRes = () => ({ ok: true, status: 200, body: null });
  const status = (s: number) => ({ ok: false, status: s, body: null });

  async function insertRow(over: { telegramStatus?: 'PENDING' | 'SENDING' | 'SENT' | null; recipientId?: string; cid?: string; claimedAt?: Date; nextAttemptAt?: Date; attempts?: number; type?: string } = {}) {
    return systemPrisma.notification.create({
      data: {
        companyId: over.cid ?? companyId,
        recipientId: over.recipientId ?? linkedId,
        type: over.type ?? 'test.delivery',
        title: MSG,
        message: MSG,
        telegramStatus: over.telegramStatus === undefined ? 'PENDING' : over.telegramStatus,
        telegramClaimedAt: over.claimedAt,
        telegramNextAttemptAt: over.nextAttemptAt,
        telegramAttempts: over.attempts ?? 0,
      },
    });
  }
  const reload = (id: string) => systemPrisma.notification.findUniqueOrThrow({ where: { id } });

  describe('notify() insert', () => {
    it('PENDING for a linked recipient, SKIPPED/TELEGRAM_NOT_LINKED otherwise; enqueues by id only after commit', async () => {
      const queue = new FakeBullQueue();
      const svc = new NotificationsService(tenantPrisma, config, queue.asQueue<NotificationDeliveryJobData>());
      const fetchMock = stubFetch(async () => okRes());
      let enqueuedInsideTx = -1;
      await tenantPrisma.run(companyId, async (tx) => {
        await svc.notify(tx, { recipientId: linkedId, type: 'test.a', title: MSG, message: MSG });
        await svc.notify(tx, { recipientId: unlinkedId, type: 'test.a', title: MSG, message: MSG });
        enqueuedInsideTx = queue.jobs.size;
      });
      expect(enqueuedInsideTx).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      const rows = await systemPrisma.notification.findMany({ where: { companyId, type: 'test.a' } });
      const linked = rows.find((r) => r.recipientId === linkedId)!;
      const unlinked = rows.find((r) => r.recipientId === unlinkedId)!;
      expect(linked.telegramStatus).toBe('PENDING');
      expect(unlinked.telegramStatus).toBe('SKIPPED');
      expect(unlinked.telegramLastError).toBe('TELEGRAM_NOT_LINKED');
      expect([...queue.jobs.keys()]).toEqual([linked.id]);
    });

    it('repeated notify with the same dedupKey yields one row and does not abort the tx', async () => {
      const svc = new NotificationsService(tenantPrisma, config);
      const key = `test.dedup:${randomUUID()}`;
      await tenantPrisma.run(companyId, async (tx) => {
        await svc.notify(tx, { recipientId: linkedId, type: 'test.dedup', title: MSG, message: MSG, dedupKey: key });
        await svc.notify(tx, { recipientId: linkedId, type: 'test.dedup', title: MSG, message: MSG, dedupKey: key });
        await svc.notify(tx, { recipientId: linkedId, type: 'test.dedup', title: MSG, message: MSG, dedupKey: `${key}-2` }); // tx still usable
      });
      await tenantPrisma.run(companyId, (tx) => svc.notify(tx, { recipientId: linkedId, type: 'test.dedup', title: MSG, message: MSG, dedupKey: key }));
      expect(await systemPrisma.notification.count({ where: { companyId, dedupKey: key } })).toBe(1);
    });

    it('Redis down at commit: the request succeeds, the row stays PENDING and a later sweep delivers it', async () => {
      process.env.QUEUE_ENQUEUE_TIMEOUT_MS = '200';
      const hanging = { add: vi.fn(() => new Promise(() => undefined)), getJob: vi.fn(() => new Promise(() => undefined)) } as unknown as Queue<NotificationDeliveryJobData>;
      const svc = new NotificationsService(tenantPrisma, config, hanging);
      await tenantPrisma.run(companyId, (tx) => svc.notify(tx, { recipientId: linkedId, type: 'test.redisdown', title: MSG, message: MSG }));
      const row = await systemPrisma.notification.findFirstOrThrow({ where: { companyId, type: 'test.redisdown' } });
      expect(row.telegramStatus).toBe('PENDING');

      const back = new FakeBullQueue();
      const sweep = new NotificationDeliverySweepService(back.asQueue<NotificationDeliveryJobData>());
      await sweep.sweep();
      expect(back.jobs.has(row.id)).toBe(true);
      const fetchMock = stubFetch(async () => okRes());
      expect(await delivery.deliver(companyId, row.id)).toBe('SENT');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await reload(row.id)).telegramStatus).toBe('SENT');
    });
  });

  describe('worker', () => {
    it('ok -> SENT with sentAt; the bot token is only in the URL', async () => {
      const row = await insertRow();
      const f = stubFetch(async () => okRes());
      expect(await delivery.deliver(companyId, row.id)).toBe('SENT');
      const after = await reload(row.id);
      expect(after.telegramStatus).toBe('SENT');
      expect(after.telegramSentAt).not.toBeNull();
      expect(after.telegramAttempts).toBe(1);
      expect(String((f.mock.calls[0] as unknown[])[0])).toContain(TOKEN);
      // idempotent: a redelivered job is a no-op
      expect(await delivery.deliver(companyId, row.id)).toBe('NOOP');
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('HTTP 500 retries with growing backoff, then FAILED at the attempt limit; lastError is a bare code', async () => {
      const row = await insertRow();
      const f = stubFetch(async () => status(500));
      let now = new Date();
      const waits: number[] = [];
      for (let i = 1; i <= TELEGRAM_MAX_ATTEMPTS; i++) {
        const out = await delivery.deliver(companyId, row.id, now);
        const r = await reload(row.id);
        expect(r.telegramAttempts).toBe(i);
        if (i < TELEGRAM_MAX_ATTEMPTS) {
          expect(out).toBe('RETRY');
          expect(r.telegramStatus).toBe('PENDING');
          waits.push(r.telegramNextAttemptAt!.getTime() - Date.now());
          // not due yet -> NOOP
          expect(await delivery.deliver(companyId, row.id, now)).toBe('NOOP');
          now = new Date(r.telegramNextAttemptAt!.getTime() + 1);
        } else {
          expect(out).toBe('FAILED');
          expect(r.telegramStatus).toBe('FAILED');
        }
      }
      expect(f).toHaveBeenCalledTimes(TELEGRAM_MAX_ATTEMPTS);
      expect(waits[1]!).toBeGreaterThan(waits[0]!);
      const last = await reload(row.id);
      expect(last.telegramLastError).toBe('HTTP_500');
      expect(await delivery.deliver(companyId, row.id, new Date(Date.now() + 10 * 3600_000))).toBe('NOOP');
    });

    it('network error is retryable and never leaks the token/URL', async () => {
      const row = await insertRow();
      stubFetch(async () => {
        throw new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`, { cause: { code: 'ECONNREFUSED' } });
      });
      expect(await delivery.deliver(companyId, row.id)).toBe('RETRY');
      const r = await reload(row.id);
      expect(r.telegramStatus).toBe('PENDING');
      expect(r.telegramLastError).toBe('NETWORK:TypeError:ECONNREFUSED');
      expect(r.telegramLastError).not.toContain(TOKEN);
    });

    it('429 retries; other 4xx fails immediately', async () => {
      const a = await insertRow();
      stubFetch(async () => status(429));
      expect(await delivery.deliver(companyId, a.id)).toBe('RETRY');
      const b = await insertRow();
      stubFetch(async () => status(403));
      expect(await delivery.deliver(companyId, b.id)).toBe('FAILED');
      expect((await reload(b.id)).telegramLastError).toBe('HTTP_403');
    });

    it('missing bot token is never marked SENT: retryable PENDING with TELEGRAM_BOT_TOKEN_MISSING', async () => {
      const row = await insertRow();
      const f = stubFetch(async () => okRes());
      const noToken = new NotificationDeliveryService(tenantPrisma, cfg(''));
      expect(await noToken.deliver(companyId, row.id)).toBe('RETRY');
      const r = await reload(row.id);
      expect(r.telegramStatus).toBe('PENDING');
      expect(r.telegramLastError).toBe('TELEGRAM_BOT_TOKEN_MISSING');
      expect(f).not.toHaveBeenCalled();
    });

    it('re-checks the recipient at send time: inactive or unlinked -> SKIPPED, nothing sent', async () => {
      const f = stubFetch(async () => okRes());
      const u1 = await systemPrisma.user.create({ data: { companyId, firstName: 'I', lastName: 'A', phone: `+99894${Math.floor(1e6 + Math.random() * 8e6)}`, telegramId: BigInt(++tg) } });
      const r1 = await insertRow({ recipientId: u1.id });
      await systemPrisma.user.update({ where: { id: u1.id }, data: { isActive: false } });
      expect(await delivery.deliver(companyId, r1.id)).toBe('SKIPPED');
      expect((await reload(r1.id)).telegramLastError).toBe('RECIPIENT_INACTIVE');

      const u2 = await systemPrisma.user.create({ data: { companyId, firstName: 'U', lastName: 'L', phone: `+99895${Math.floor(1e6 + Math.random() * 8e6)}`, telegramId: BigInt(++tg) } });
      const r2 = await insertRow({ recipientId: u2.id });
      await systemPrisma.user.update({ where: { id: u2.id }, data: { telegramId: null } });
      expect(await delivery.deliver(companyId, r2.id)).toBe('SKIPPED');
      expect((await reload(r2.id)).telegramLastError).toBe('TELEGRAM_NOT_LINKED');
      expect(f).not.toHaveBeenCalled();
    });

    it('owner-alert type: role removed after commit -> SKIPPED RECIPIENT_NOT_OWNER, nothing sent; other types unaffected', async () => {
      const f = stubFetch(async () => okRes());
      const role = await systemPrisma.role.create({ data: { companyId, name: 'Owner', code: 'OWNER' } });
      const u = await systemPrisma.user.create({ data: { companyId, firstName: 'O', lastName: 'W', phone: `+99896${Math.floor(1e6 + Math.random() * 8e6)}`, telegramId: BigInt(++tg) } });
      await systemPrisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
      const kept = await insertRow({ recipientId: u.id, type: 'payment.reversed' });
      expect(await delivery.deliver(companyId, kept.id)).toBe('SENT');
      const alert = await insertRow({ recipientId: u.id, type: 'stock.adjusted' });
      const plain = await insertRow({ recipientId: u.id });
      await systemPrisma.userRole.deleteMany({ where: { userId: u.id } });
      f.mockClear();
      expect(await delivery.deliver(companyId, alert.id)).toBe('SKIPPED');
      expect((await reload(alert.id)).telegramLastError).toBe('RECIPIENT_NOT_OWNER');
      expect(f).not.toHaveBeenCalled();
      expect(await delivery.deliver(companyId, plain.id)).toBe('SENT');
    });

    it('wrong companyId cannot touch another tenant row (RLS)', async () => {
      const row = await insertRow();
      const f = stubFetch(async () => okRes());
      expect(await delivery.deliver(otherCompanyId, row.id)).toBe('NOOP');
      expect(f).not.toHaveBeenCalled();
      expect((await reload(row.id)).telegramStatus).toBe('PENDING');
    });

    it('two concurrent workers on one row send exactly once', async () => {
      const rows = await Promise.all([insertRow(), insertRow(), insertRow()]);
      const f = stubFetch(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return okRes();
      });
      for (const row of rows) {
        const outcomes = await Promise.all([delivery.deliver(companyId, row.id), delivery.deliver(companyId, row.id)]);
        expect(outcomes.sort()).toEqual(['NOOP', 'SENT']);
      }
      expect(f).toHaveBeenCalledTimes(rows.length);
    });

    it('crashed worker (SENDING, lease expired) is recovered; a live lease is respected; attempts stay bounded', async () => {
      const f = stubFetch(async () => okRes());
      const crashed = await insertRow({ telegramStatus: 'SENDING', claimedAt: new Date(Date.now() - TELEGRAM_LEASE_MS - 60_000), attempts: 1 });
      const live = await insertRow({ telegramStatus: 'SENDING', claimedAt: new Date(), attempts: 1 });
      const exhausted = await insertRow({ telegramStatus: 'SENDING', claimedAt: new Date(Date.now() - TELEGRAM_LEASE_MS - 60_000), attempts: TELEGRAM_MAX_ATTEMPTS });
      expect(await delivery.deliver(companyId, crashed.id)).toBe('SENT');
      expect(await delivery.deliver(companyId, live.id)).toBe('NOOP');
      expect(await delivery.deliver(companyId, exhausted.id)).toBe('FAILED');
      expect((await reload(exhausted.id)).telegramLastError).toBe('LEASE_EXPIRED_MAX_ATTEMPTS');
      expect(f).toHaveBeenCalledTimes(1);
    });
  });

  describe('sweep', () => {
    it('enqueues due PENDING and lease-expired SENDING (with the row companyId), skips future/legacy/terminal rows', async () => {
      const due = await insertRow({ nextAttemptAt: new Date(Date.now() - 1000) });
      const otherDue = await insertRow({ cid: otherCompanyId, recipientId: otherLinkedId });
      const stale = await insertRow({ telegramStatus: 'SENDING', claimedAt: new Date(Date.now() - TELEGRAM_LEASE_MS - 1000), attempts: 1 });
      const future = await insertRow({ nextAttemptAt: new Date(Date.now() + 3600_000) });
      const legacy = await insertRow({ telegramStatus: null });
      const sent = await insertRow({ telegramStatus: 'SENT' });
      const liveLease = await insertRow({ telegramStatus: 'SENDING', claimedAt: new Date() });
      const queue = new FakeBullQueue();
      const sweep = new NotificationDeliverySweepService(queue.asQueue<NotificationDeliveryJobData>());
      await sweep.sweep();
      const ids = new Set(queue.jobs.keys());
      for (const r of [due, otherDue, stale]) expect(ids.has(r.id)).toBe(true);
      for (const r of [future, legacy, sent, liveLease]) expect(ids.has(r.id)).toBe(false);
      expect((queue.jobs.get(otherDue.id)!.data as NotificationDeliveryJobData).companyId).toBe(otherCompanyId);
      expect((queue.jobs.get(due.id)!.data as NotificationDeliveryJobData).companyId).toBe(companyId);
      // idempotent re-sweep (same jobIds)
      await sweep.sweep();
      expect(queue.jobs.size).toBe(ids.size);
    });

    it('Redis error: DB unchanged, no throw, next tick succeeds; one failing row does not abort the rest', async () => {
      const row = await insertRow({ nextAttemptAt: new Date(Date.now() - 1000) });
      const before = await reload(row.id);
      const failing = { getJob: async () => { throw new Error('ECONNREFUSED'); }, add: async () => { throw new Error('ECONNREFUSED'); } } as unknown as Queue<NotificationDeliveryJobData>;
      await expect(new NotificationDeliverySweepService(failing).sweep()).resolves.toBe(0);
      const after = await reload(row.id);
      expect(after.telegramStatus).toBe(before.telegramStatus);
      expect(after.updatedAt).toEqual(before.updatedAt);

      const q = new FakeBullQueue();
      const flaky = { getJob: q.getJob, add: vi.fn(async (n: string, d: { notificationId: string }, o: { jobId: string }) => { if (d.notificationId === row.id) throw new Error('boom'); return q.add(n, d, o); }) } as unknown as Queue<NotificationDeliveryJobData>;
      const other = await insertRow({ nextAttemptAt: new Date(Date.now() - 1000) });
      await new NotificationDeliverySweepService(flaky).sweep();
      expect(q.jobs.has(other.id)).toBe(true);
      const ok = new FakeBullQueue();
      await new NotificationDeliverySweepService(ok.asQueue<NotificationDeliveryJobData>()).sweep();
      expect(ok.jobs.has(row.id)).toBe(true);
    });
  });
});
