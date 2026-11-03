import { describe, expect, it } from 'vitest';
import { Prisma } from '@velto/database';
import { DEFAULT_TIME_ZONE, isoWeekday, pctChange, resolveDateRange } from './report-utils';

describe('report-utils', () => {
  describe('isoWeekday', () => {
    it('maps Monday to 1 and Sunday to 7 (ISO 8601, matching Route.weekday 6.8)', () => {
      expect(isoWeekday(new Date('2026-08-03T12:00:00Z'))).toBe(1); // Monday
      expect(isoWeekday(new Date('2026-08-09T12:00:00Z'))).toBe(7); // Sunday
    });
  });

  describe('pctChange', () => {
    it('returns null when growing from a zero base (undefined growth rate)', () => {
      expect(pctChange(100, 0)).toBeNull();
    });

    it('returns 0 when both values are zero', () => {
      expect(pctChange(0, 0)).toBe(0);
    });

    it('computes a signed percentage otherwise', () => {
      expect(pctChange(150, 100)).toBe(50);
      expect(pctChange(50, 100)).toBe(-50);
    });

    it('accepts Prisma.Decimal operands', () => {
      expect(pctChange(new Prisma.Decimal(120), new Prisma.Decimal(100))).toBe(20);
    });
  });

  describe('resolveDateRange', () => {
    it('defaults to a 30 calendar-day window ending today when no bounds are given', () => {
      const { start, end } = resolveDateRange();
      // start is 00:00:00.000 29 days back, end is 23:59:59.999 today — a
      // span of 29 days plus one day's worth of milliseconds, which rounds
      // up to 30: today plus the 29 days before it.
      const days = Math.round((end.getTime() - start.getTime()) / (24 * 3600 * 1000));
      expect(days).toBe(30);
    });

    it('extends an explicit `to` date to its end-of-day boundary', () => {
      const { start, end } = resolveDateRange('2026-01-01', '2026-01-10');
      // Company-day boundaries in DEFAULT_TIME_ZONE (Asia/Tashkent, UTC+5, no DST),
      // asserted as exact instants so the result is independent of the host TZ.
      expect(DEFAULT_TIME_ZONE).toBe('Asia/Tashkent');
      expect(start.toISOString()).toBe('2025-12-31T19:00:00.000Z');
      expect(end.toISOString()).toBe('2026-01-10T18:59:59.999Z');
    });
  });
});
