import { describe, expect, it } from 'vitest';
import { buildVisitGpsFields, gpsFieldsFromSearchParams, gpsFieldsToSearchParams, localGpsStatus } from './gps-payload';

const fix = { latitude: 41.3, longitude: 69.2, accuracyM: 12.5, capturedAt: '2026-10-13T08:00:00.000Z', permissionDenied: false };

describe('visit GPS payload', () => {
  it('includes coords, accuracy and capturedAt, never gpsOk/gpsStatus', () => {
    const f = buildVisitGpsFields(fix);
    expect(f).toEqual({ latitude: 41.3, longitude: 69.2, accuracyM: 12.5, capturedAt: '2026-10-13T08:00:00.000Z' });
    expect(f).not.toHaveProperty('gpsOk');
    expect(f).not.toHaveProperty('gpsStatus');
  });

  it('permission denied sends permissionDenied:true and no coords', () => {
    expect(buildVisitGpsFields({ ...fix, latitude: null, longitude: null, permissionDenied: true })).toEqual({ permissionDenied: true });
  });

  it('timeout/unavailable sends nothing', () => {
    expect(buildVisitGpsFields({ latitude: null, longitude: null, accuracyM: null, capturedAt: null, permissionDenied: false })).toEqual({});
  });

  it('round-trips through the /order/new handoff query', () => {
    const sp = new URLSearchParams();
    gpsFieldsToSearchParams(buildVisitGpsFields(fix), sp);
    expect(gpsFieldsFromSearchParams(sp)).toEqual(buildVisitGpsFields(fix));
    const denied = new URLSearchParams();
    gpsFieldsToSearchParams({ permissionDenied: true }, denied);
    expect(gpsFieldsFromSearchParams(denied)).toEqual({ permissionDenied: true });
    expect(gpsFieldsFromSearchParams(new URLSearchParams())).toEqual({});
  });

  it('derives only device-knowable statuses', () => {
    expect(localGpsStatus({ permissionDenied: true }, true)).toBe('NO_PERMISSION');
    expect(localGpsStatus({}, true)).toBe('NO_FIX');
    expect(localGpsStatus(buildVisitGpsFields(fix), false)).toBe('OUTLET_NO_COORDS');
    expect(localGpsStatus(buildVisitGpsFields(fix), true)).toBeNull();
  });
});
