import { HttpStatus } from '@nestjs/common';
import { AppException } from '../errors/app-exception';

export class IdempotencyKeyReusedException extends AppException {
  constructor() {
    super(HttpStatus.UNPROCESSABLE_ENTITY, 'IDEMPOTENCY_KEY_REUSED', {
      uz: "Idempotency-Key boshqa so'rov uchun allaqachon ishlatilgan",
      ru: 'Idempotency-Key уже использован для другого запроса',
      en: 'Idempotency-Key was already used for a different request',
    });
  }
}

export class InvalidIdempotencyKeyException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'IDEMPOTENCY_KEY_INVALID', {
      uz: "Idempotency-Key noto'g'ri (1-128 belgi bo'lishi kerak)",
      ru: 'Некорректный Idempotency-Key (1-128 символов)',
      en: 'Invalid Idempotency-Key (must be 1-128 characters)',
    });
  }
}
