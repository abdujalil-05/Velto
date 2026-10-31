import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SessionExpiredException } from './auth-exceptions';

describe('JwtAuthGuard sid requirement (ADR-058)', () => {
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m' } });
  const guard = new JwtAuthGuard(jwt, new Reflector());
  const ctx = (token: string) => {
    const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
    return { request, context: { getHandler: () => ctx, getClass: () => JwtAuthGuard, switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext };
  };

  it('sid-less access token -> AUTH_SESSION_EXPIRED 401', async () => {
    const { context } = ctx(await jwt.signAsync({ sub: 'u', companyId: 'c', roles: [] }));
    const err = await guard.canActivate(context).catch((e) => e);
    expect(err).toBeInstanceOf(SessionExpiredException);
    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toMatchObject({ code: 'AUTH_SESSION_EXPIRED', message: { ru: 'Сессия истекла. Войдите снова.' } });
  });

  it('token with sid passes', async () => {
    const { context, request } = ctx(await jwt.signAsync({ sub: 'u', companyId: 'c', roles: [], sid: 's1' }));
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.tokenPayload).toMatchObject({ sid: 's1' });
  });
});
