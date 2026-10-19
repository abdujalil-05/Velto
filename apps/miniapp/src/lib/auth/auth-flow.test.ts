import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canExportRevoked, clearRevokedInfo } from '@/lib/offline/revoke-wipe';
import { getLastKnownOwner, setOfflineSession, setOwnerTelegramId } from '@/lib/offline/session';
import { clearTokens, getRefreshToken, setTokens } from './tokens';
import { resumeSession, telegramLogin } from './auth-flow';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = { userId: 'uA', companyId: 'c1' };

describe('auth flow revoke handling', () => {
  beforeEach(() => {
    clearTokens();
    clearRevokedInfo();
    window.localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('telegram login 403 AUTH_ACCOUNT_BLOCKED wipes and returns blocked', async () => {
    setOfflineSession(A);
    setOwnerTelegramId(777);
    vi.stubGlobal('fetch', async () => json(403, { code: 'AUTH_ACCOUNT_BLOCKED', message: { uz: '', ru: '', en: 'blocked' } }));
    const res = await telegramLogin('init', 777);
    expect(res.kind).toBe('blocked');
    expect(getLastKnownOwner()).toBeNull();
  });

  it('telegram login other failure does not wipe', async () => {
    setOfflineSession(A);
    vi.stubGlobal('fetch', async () => json(401, { code: 'AUTH_INVALID', message: { uz: '', ru: '', en: 'x' } }));
    expect((await telegramLogin('init')).kind).toBe('failed');
    expect(getLastKnownOwner()).toEqual(A);
  });

  it('bootstrap network error keeps tokens', async () => {
    setTokens('a', 'r');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await resumeSession()).kind).toBe('offline');
    expect(getRefreshToken()).toBe('r');
  });

  it('bootstrap 5xx keeps tokens; 401 with no refresh outcome clears them', async () => {
    setTokens('a', 'r');
    vi.stubGlobal('fetch', async () => json(503, { code: 'X', message: { uz: '', ru: '', en: 'x' } }));
    expect((await resumeSession()).kind).toBe('offline');
    expect(getRefreshToken()).toBe('r');
    vi.stubGlobal('fetch', async () => json(403, { code: 'FORBIDDEN', message: { uz: '', ru: '', en: 'x' } }));
    expect((await resumeSession()).kind).toBe('rejected');
    expect(getRefreshToken()).toBeNull();
  });
});

describe('canExportRevoked', () => {
  it('matches only the owner telegram id', () => {
    expect(canExportRevoked({ telegramId: '777' }, 777)).toBe(true);
    expect(canExportRevoked({ telegramId: '777' }, 888)).toBe(false);
    expect(canExportRevoked({ telegramId: '777' }, undefined)).toBe(false);
    expect(canExportRevoked({}, 777)).toBe(false);
  });
});

