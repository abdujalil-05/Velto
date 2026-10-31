import { randomInt } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { generate } from 'otplib';
import request from 'supertest';

export interface MfaLoginResult {
  accessToken: string;
  /** Set-Cookie header of the session-issuing response (refresh cookie). */
  cookies?: string[];
  /** Base32 TOTP secret, set when this login enrolled MFA. Reuse it for later `verify` logins. */
  secret?: string;
  recoveryCodes?: string[];
}

/** Random loopback-range IP so the per-IP MFA throttle (10 / 5 min) never couples unrelated test users. */
export function randomIp(): string {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

/**
 * Test helper for ADR-058: POST /auth/login for any user. Non-privileged => plain token.
 * Privileged => enrolls TOTP on first login (`secret` omitted) or verifies with the given `secret`.
 */
export async function loginWithMfa(app: INestApplication, phone: string, password: string, secret?: string): Promise<MfaLoginResult> {
  app.getHttpAdapter().getInstance().set('trust proxy', true);
  const http = () => request(app.getHttpServer());
  const ip = randomIp();
  const login = await http().post('/auth/login').set('X-Forwarded-For', ip).send({ phone, password }).expect(201);
  if (!login.body.mfa) return { accessToken: login.body.accessToken as string, cookies: login.headers['set-cookie'] as unknown as string[] };
  const mfaChallenge = login.body.mfaChallenge as string;
  if (login.body.mfa === 'verify') {
    if (!secret) throw new Error('verify login needs the enrolled TOTP secret');
    const res = await http()
      .post('/auth/mfa/verify')
      .set('X-Forwarded-For', ip)
      .send({ mfaChallenge, code: await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 }) }) // next step: enrollment/earlier logins already consumed the current one
      .expect(200);
    return { accessToken: res.body.accessToken as string, cookies: res.headers['set-cookie'] as unknown as string[], secret };
  }
  const start = await http().post('/auth/mfa/enroll/start').set('X-Forwarded-For', ip).send({ mfaChallenge }).expect(200);
  const newSecret = start.body.secret as string;
  const res = await http()
    .post('/auth/mfa/enroll/confirm')
    .set('X-Forwarded-For', ip)
    .send({ mfaChallenge, code: await generate({ secret: newSecret }) })
    .expect(200);
  return { accessToken: res.body.accessToken as string, cookies: res.headers['set-cookie'] as unknown as string[], secret: newSecret, recoveryCodes: res.body.recoveryCodes as string[] };
}
