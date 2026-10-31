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

export class TelegramReplayRejectedException extends AppException {
  constructor() {
    super(HttpStatus.UNAUTHORIZED, 'AUTH_TELEGRAM_REPLAY', {
      uz: "Telegram so'rovi qayta ishlatilgan. Mini App'ni qayta oching",
      ru: 'Данные Telegram уже использованы. Откройте Mini App заново',
      en: 'Telegram login data was reused too many times. Reopen the Mini App',
    });
  }
}

/** Replay protection needs Redis; without it login fails closed (503, retryable) rather than skipping the check. */
export class TelegramAuthUnavailableException extends AppException {
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'AUTH_TELEGRAM_UNAVAILABLE', {
      uz: "Kirish vaqtincha mavjud emas. Birozdan so'ng qayta urining",
      ru: 'Вход временно недоступен. Повторите чуть позже',
      en: 'Login is temporarily unavailable. Please retry shortly',
    });
  }
}

/** ADR-057/057a: missing, expired, replayed or forged company-selection / account-selection handle. One generic answer for all. */
export class AuthChallengeInvalidException extends AppException {
  constructor() {
    super(HttpStatus.UNAUTHORIZED, 'AUTH_CHALLENGE_INVALID', {
      uz: "Tanlov muddati tugagan yoki yaroqsiz. Qaytadan urinib ko'ring",
      ru: 'Выбор недействителен или истёк. Повторите попытку',
      en: 'The selection is invalid or has expired. Please try again',
    });
  }
}

export class AuthChallengeRateLimitedException extends AppException {
  constructor(retryAfterSeconds: number) {
    super(
      HttpStatus.TOO_MANY_REQUESTS,
      'AUTH_CHALLENGE_RATE_LIMITED',
      {
        uz: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring",
        ru: 'Слишком много попыток. Повторите позже',
        en: 'Too many attempts. Please try again later',
      },
      { retryAfterSeconds },
    );
  }
}

/** ADR-058: the session (access or refresh token) is not backed by the user's current confirmed MFA. Client must log in again. */
export class MfaRequiredException extends AppException {
  constructor() {
    super(HttpStatus.UNAUTHORIZED, 'MFA_REQUIRED', {
      uz: 'Ikki bosqichli tasdiqlash talab etiladi. Qaytadan kiring',
      ru: 'Требуется двухфакторная аутентификация. Войдите снова',
      en: 'Two-factor authentication is required. Please log in again',
    });
  }
}

export class MfaCodeInvalidException extends AppException {
  constructor() {
    super(HttpStatus.UNAUTHORIZED, 'MFA_CODE_INVALID', {
      uz: "Tasdiqlash kodi noto'g'ri",
      ru: 'Неверный код подтверждения',
      en: 'Invalid verification code',
    });
  }
}

/** First MFA enrollment code missing/wrong/expired/used/other user's. One generic answer for all (no existence oracle). */
export class MfaEnrollmentCodeInvalidException extends AppException {
  constructor() {
    super(HttpStatus.UNAUTHORIZED, 'MFA_ENROLLMENT_CODE_INVALID', {
      uz: "Ro'yxatdan o'tkazish kodi noto'g'ri yoki muddati o'tgan",
      ru: 'Код регистрации неверен или истёк',
      en: 'The enrollment code is invalid or expired',
    });
  }
}

/** Expired, already used, wrong-scope or attempt-exhausted MFA challenge. One generic answer for all. */
export class MfaChallengeInvalidException extends AppException {
  constructor() {
    super(HttpStatus.UNAUTHORIZED, 'MFA_CHALLENGE_INVALID', {
      uz: "Tasdiqlash sessiyasi tugagan yoki yaroqsiz. Qaytadan kiring",
      ru: 'Сессия подтверждения недействительна или истекла. Войдите снова',
      en: 'The verification session is invalid or has expired. Please log in again',
    });
  }
}

export class MfaRateLimitedException extends AppException {
  constructor(retryAfterSeconds: number) {
    super(
      HttpStatus.TOO_MANY_REQUESTS,
      'MFA_RATE_LIMITED',
      {
        uz: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring",
        ru: 'Слишком много попыток. Повторите позже',
        en: 'Too many attempts. Please try again later',
      },
      { retryAfterSeconds },
    );
  }
}

/** ADR-058: Telegram initData is never a second factor — privileged roles must use the web login with TOTP. */
export class MfaWebLoginRequiredException extends AppException {
  constructor() {
    super(HttpStatus.FORBIDDEN, 'MFA_WEB_LOGIN_REQUIRED', {
      uz: "Bu rol uchun faqat veb-ilova orqali, ikki bosqichli tasdiqlash bilan kirish mumkin",
      ru: 'Для этой роли вход возможен только через веб-приложение с двухфакторной аутентификацией',
      en: 'This role can only sign in through the web app with two-factor authentication',
    });
  }
}

/** Redis (challenge store / throttles) is down: MFA can never be skipped, so the whole step fails closed. */
export class MfaServiceUnavailableException extends AppException {
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'MFA_SERVICE_UNAVAILABLE', {
      uz: "Tasdiqlash xizmati vaqtincha mavjud emas. Birozdan keyin qayta urinib ko'ring",
      ru: 'Сервис подтверждения временно недоступен. Повторите попытку позже',
      en: 'Verification service temporarily unavailable. Please try again shortly',
    });
  }
}
