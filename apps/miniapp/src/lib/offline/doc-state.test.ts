import { describe, expect, it } from 'vitest';
import { DOC_STATES, docStateView } from './doc-state';
import uz from '../../../messages/uz.json';
import ru from '../../../messages/ru.json';
import en from '../../../messages/en.json';

describe('doc-state (TZ 8.6 labels)', () => {
  it('separates device-only, send-pending, server-accepted and needs-attention', () => {
    expect(docStateView('PENDING', undefined, 0).state).toBe('deviceOnly');
    expect(docStateView('PENDING', undefined, 2).state).toBe('sendPending');
    expect(docStateView('SYNCING').state).toBe('sendPending');
    expect(docStateView('SYNCED').state).toBe('serverAccepted');
    expect(docStateView('FAILED')).toEqual({ state: 'needsAttention', variant: 'destructive', detailKey: 'failed' });
    expect(docStateView('CONFLICT')).toEqual({ state: 'needsAttention', variant: 'warning', detailKey: 'conflict' });
  });

  it('maps ADR-029 cashier handover after server ACK without hiding the server-accepted state', () => {
    expect(docStateView('PENDING', 'POSTED').state).toBe('deviceOnly');
    expect(docStateView('SYNCED', 'PENDING_HANDOVER')).toEqual({ state: 'serverAccepted', variant: 'warning', detailKey: 'handoverPending' });
    expect(docStateView('SYNCED', 'POSTED')).toEqual({ state: 'serverAccepted', variant: 'success', detailKey: 'handoverPosted' });
    expect(docStateView('SYNCED', 'REJECTED')).toEqual({ state: 'needsAttention', variant: 'destructive', detailKey: 'handoverRejected' });
  });

  it('every state and detail key has a Queue message in uz/ru/en', () => {
    const keys = [...DOC_STATES, 'failed', 'conflict', 'handoverPending', 'handoverPosted', 'handoverRejected'];
    for (const m of [uz, ru, en]) for (const k of keys) expect((m.Queue as unknown as Record<string, string>)[k]).toBeTruthy();
    expect([uz.Queue.deviceOnly, uz.Queue.sendPending, uz.Queue.serverAccepted, uz.Queue.needsAttention]).toEqual(["Faqat shu qurilmada", 'Yuborish kutilmoqda', 'Server qabul qildi', "E'tibor kerak"]);
  });

  it('F7: PENDING held back by maintenance / rate limit is calm send-pending with a reason, never needs-attention', () => {
    expect(docStateView('PENDING', undefined, 0, 'MAINTENANCE_READ_ONLY')).toEqual({ state: 'sendPending', variant: 'secondary', detailKey: 'maintenance' });
    expect(docStateView('PENDING', undefined, 0, 'RATE_LIMITED')).toEqual({ state: 'sendPending', variant: 'secondary', detailKey: 'rateLimited' });
    expect(uz.Queue.maintenance).toBe('Tizimda texnik ishlar, yozuvlar saqlandi');
    expect(uz.Queue.rateLimited).toBe("So'rovlar ko'p, birozdan keyin yuboriladi");
    for (const m of [uz, ru, en]) for (const k of ['maintenance', 'rateLimited', 'maintenanceBody', 'rateLimitedBody', 'busy', 'busyBody', 'busyTitle']) expect((m.Queue as unknown as Record<string, string>)[k]).toBeTruthy();
  });
});
