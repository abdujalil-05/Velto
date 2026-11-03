import { describe, expect, it } from 'vitest';
import { courierStatusLabelKey, isAwaitingHandover } from './order-status';

describe('courier handover state', () => {
  it('assigned CONFIRMED orders await handover; every other status keeps its own label', () => {
    expect(isAwaitingHandover('CONFIRMED')).toBe(true);
    expect(courierStatusLabelKey('CONFIRMED')).toBe('awaitingHandover');
    expect(isAwaitingHandover('SHIPPED')).toBe(false);
    expect(courierStatusLabelKey('SHIPPED')).toBe('status.SHIPPED');
  });
});
