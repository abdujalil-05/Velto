import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { NotificationNotFoundException } from './notifications-exceptions';
import { NotificationsService } from './notifications.service';

const MSG = { uz: 'Test', ru: 'Тест', en: 'Test' };

describe('NotificationsService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let recipientId: string;
  let otherUserId: string;

  const tenantPrisma = new TenantPrismaService();
  const notifications = new NotificationsService(tenantPrisma, new ConfigService());

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-notifications-${Date.now()}`, name: 'Notifications Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Notifications Test Co' } });
    companyId = company.id;

    const recipient = await systemPrisma.user.create({
      data: { companyId, firstName: 'Recip', lastName: 'Ient', phone: '+998900000096' },
    });
    recipientId = recipient.id;
    const otherUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Other', lastName: 'User', phone: '+998900000095' },
    });
    otherUserId = otherUser.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('notify() creates an in-app row (no Telegram attempt when the recipient has no telegramId)', async () => {
    await tenantPrisma.run(companyId, (tx) =>
      notifications.notify(tx, { recipientId, type: 'test.event', title: MSG, message: MSG }),
    );

    const list = await tenantPrisma.run(companyId, () => notifications.list(recipientId, { page: 1, pageSize: 25 }));
    expect(list.data.some((n) => n.type === 'test.event')).toBe(true);
  });

  it('notifyMany() fans out to every recipient', async () => {
    const third = await systemPrisma.user.create({ data: { companyId, firstName: 'C', lastName: 'C', phone: '+998900000094' } });

    await tenantPrisma.run(companyId, (tx) =>
      notifications.notifyMany(tx, [recipientId, third.id], { type: 'test.fanout', title: MSG, message: MSG }),
    );

    const [listA, listB] = await Promise.all([
      tenantPrisma.run(companyId, () => notifications.list(recipientId, { page: 1, pageSize: 25 })),
      tenantPrisma.run(companyId, () => notifications.list(third.id, { page: 1, pageSize: 25 })),
    ]);
    expect(listA.data.some((n) => n.type === 'test.fanout')).toBe(true);
    expect(listB.data.some((n) => n.type === 'test.fanout')).toBe(true);
  });

  it('list() supports unreadOnly filtering, and markRead()/markAllRead() clear it', async () => {
    const before = await tenantPrisma.run(companyId, () => notifications.unreadCount(recipientId));

    await tenantPrisma.run(companyId, (tx) =>
      notifications.notify(tx, { recipientId, type: 'test.unread', title: MSG, message: MSG }),
    );
    expect(await tenantPrisma.run(companyId, () => notifications.unreadCount(recipientId))).toBe(before + 1);

    const unread = await tenantPrisma.run(companyId, () => notifications.list(recipientId, { unreadOnly: true, page: 1, pageSize: 25 }));
    const target = unread.data.find((n) => n.type === 'test.unread')!;

    const marked = await tenantPrisma.run(companyId, () => notifications.markRead(target.id, recipientId));
    expect(marked.readAt).not.toBeNull();
    // Idempotent: marking an already-read notification again doesn't throw or change readAt to a new value type.
    const markedAgain = await tenantPrisma.run(companyId, () => notifications.markRead(target.id, recipientId));
    expect(markedAgain.readAt).toEqual(marked.readAt);

    await tenantPrisma.run(companyId, (tx) =>
      notifications.notify(tx, { recipientId, type: 'test.unread2', title: MSG, message: MSG }),
    );
    await tenantPrisma.run(companyId, () => notifications.markAllRead(recipientId));
    expect(await tenantPrisma.run(companyId, () => notifications.unreadCount(recipientId))).toBe(0);
  });

  it('markRead() refuses to mark another user\'s notification (object-level scoping)', async () => {
    const mine = await tenantPrisma.run(companyId, (tx) =>
      tx.notification.create({
        data: { companyId, recipientId, type: 'test.mine', title: MSG, message: MSG },
      }),
    );

    await expect(tenantPrisma.run(companyId, () => notifications.markRead(mine.id, otherUserId))).rejects.toBeInstanceOf(
      NotificationNotFoundException,
    );
  });

  it('getById()-equivalent (markRead) throws for a nonexistent id', async () => {
    await expect(tenantPrisma.run(companyId, () => notifications.markRead(randomUUID(), recipientId))).rejects.toBeInstanceOf(
      NotificationNotFoundException,
    );
  });
});
