import { HttpStatus } from '@nestjs/common';
import { AppException } from '../errors/app-exception';

export class InvalidCredentialsException extends AppException {
  constructor() {
    super(HttpStatus.UNAUTHORIZED, 'AUTH_INVALID_CREDENTIALS', {
      uz: "Telefon raqami yoki parol noto'g'ri",
      ru: 'Неверный номер телефона или пароль',
      en: 'Invalid phone number or password',
    });
  }
}

export class TooManyLoginAttemptsException extends AppException {
  constructor(retryAfterSeconds: number) {
    super(
      HttpStatus.TOO_MANY_REQUESTS,
      'AUTH_TOO_MANY_ATTEMPTS',
      {
        uz: "Urinishlar soni oshib ketdi. Birozdan so'ng qayta urining",
        ru: 'Слишком много попыток входа. Повторите позже',
        en: 'Too many login attempts. Try again later',
      },
      { retryAfterSeconds },
    );
  }
}

export class SessionExpiredException extends AppException {
  constructor() {
    super(HttpStatus.UNAUTHORIZED, 'AUTH_SESSION_EXPIRED', {
      uz: 'Sessiya muddati tugagan. Qayta kiring',
      ru: 'Сессия истекла. Войдите снова',
      en: 'Your session has expired. Please log in again',
    });
  }
}

export class PermissionDeniedException extends AppException {
  constructor(required: string) {
    super(
      HttpStatus.FORBIDDEN,
      'PERMISSION_DENIED',
      {
        uz: "Sizda bu amal uchun ruxsat yo'q",
        ru: 'У вас нет прав для этого действия',
        en: 'You do not have permission for this action',
      },
      { required },
    );
  }
}

export class AccountBlockedException extends AppException {
  constructor() {
    super(HttpStatus.FORBIDDEN, 'AUTH_ACCOUNT_BLOCKED', {
      uz: 'Hisobingiz bloklangan. Rahbaringizga murojaat qiling',
      ru: 'Ваш аккаунт заблокирован. Обратитесь к руководителю',
      en: 'Your account has been blocked. Contact your manager',
    });
  }
}

export class PasswordResetCodeInvalidException extends AppException {
  constructor(attemptsRemaining: number) {
    super(
      HttpStatus.BAD_REQUEST,
      'AUTH_RESET_CODE_INVALID',
      {
        uz: "Kod noto'g'ri",
        ru: 'Неверный код',
        en: 'Invalid code',
      },
      { attemptsRemaining },
    );
  }
}

export class PasswordResetCodeExpiredException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'AUTH_RESET_CODE_EXPIRED', {
      uz: "Kod muddati tugagan yoki so'ralmagan. Qaytadan so'rang",
      ru: 'Код истёк или не запрашивался. Запросите новый',
      en: 'Code expired or was never requested. Request a new one',
    });
  }
}

export class PasswordResetCooldownException extends AppException {
  constructor(retryAfterSeconds: number) {
    super(
      HttpStatus.TOO_MANY_REQUESTS,
      'AUTH_RESET_COOLDOWN',
      {
        uz: "SMS allaqachon yuborilgan. Birozdan so'ng qayta urining",
        ru: 'SMS уже отправлена. Повторите чуть позже',
        en: 'An SMS was already sent. Try again shortly',
      },
      { retryAfterSeconds },
    );
  }
}
