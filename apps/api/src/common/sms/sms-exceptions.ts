import { HttpStatus } from '@nestjs/common';
import { AppException } from '../errors/app-exception';

export class SmsNotConfiguredException extends AppException {
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'SMS_NOT_CONFIGURED', {
      uz: 'SMS xizmati sozlanmagan',
      ru: 'SMS-сервис не настроен',
      en: 'SMS service is not configured',
    });
  }
}
