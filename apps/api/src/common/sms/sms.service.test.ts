import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { SmsService } from './sms.service';
import { SmsNotConfiguredException } from './sms-exceptions';

const make = (env: Record<string, string>) => {
  const svc = new SmsService({ get: (k: string, d?: string) => env[k] ?? d } as unknown as ConfigService);
  const logger = (svc as unknown as { logger: { warn: (m: string) => void } }).logger;
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  return { svc, warn };
};

describe('SmsService without SMS_API_TOKEN', () => {
  afterEach(() => vi.restoreAllMocks());

  it('production: throws SMS_NOT_CONFIGURED and never logs phone/message', async () => {
    const { svc, warn } = make({ NODE_ENV: 'production' });
    await expect(svc.send('+998901234567', 'code 123456')).rejects.toBeInstanceOf(SmsNotConfiguredException);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('998901234567');
    expect(logged).not.toContain('123456');
  });

  it('development: logs and resolves (unchanged)', async () => {
    const { svc, warn } = make({ NODE_ENV: 'development' });
    await expect(svc.send('+998901234567', 'code 123456')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('production: assertAvailable throws SMS_NOT_CONFIGURED; dev/with token passes', () => {
    expect(() => make({ NODE_ENV: 'production' }).svc.assertAvailable()).toThrow(SmsNotConfiguredException);
    expect(() => make({ NODE_ENV: 'production', SMS_API_TOKEN: 't' }).svc.assertAvailable()).not.toThrow();
    expect(() => make({ NODE_ENV: 'development' }).svc.assertAvailable()).not.toThrow();
  });
});
