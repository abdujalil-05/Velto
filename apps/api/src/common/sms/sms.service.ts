import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const ESKIZ_SEND_URL = 'https://notify.eskiz.uz/api/message/sms/send';

/**
 * INT-SMS-001: Eskiz.uz — the most widely used SMS gateway for Uzbek
 * numbers. SMS_API_TOKEN empty (dev default) logs the message instead of
 * sending it, same optional-integration pattern as TELEGRAM_BOT_TOKEN/
 * SENTRY_DSN, so callers (password reset) work in dev without a real
 * account. Swap the request below if a different provider is chosen later —
 * callers only depend on send()'s signature, not this implementation.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger('SmsService');

  constructor(private readonly configService: ConfigService) {}

  async send(phone: string, message: string): Promise<void> {
    const token = this.configService.get<string>('SMS_API_TOKEN', '');
    if (!token) {
      this.logger.warn(`[DEV MODE — no SMS_API_TOKEN configured, not sent] to=${phone}: ${message}`);
      return;
    }

    const sender = this.configService.get<string>('SMS_SENDER', '4546');
    const res = await fetch(ESKIZ_SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // Eskiz expects the number without the leading "+".
      body: JSON.stringify({ mobile_phone: phone.replace(/^\+/, ''), message, from: sender }),
    });

    if (!res.ok) {
      this.logger.error(`SMS send failed: ${res.status} ${await res.text().catch(() => '')}`);
      throw new Error('Failed to send SMS');
    }
  }
}
