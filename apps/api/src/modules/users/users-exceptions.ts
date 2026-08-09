import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class UserNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', {
      uz: 'Foydalanuvchi topilmadi',
      ru: 'Пользователь не найден',
      en: 'User not found',
    });
  }
}

export class DuplicateUserPhoneException extends AppException {
  constructor(phone: string) {
    super(
      HttpStatus.CONFLICT,
      'USER_DUPLICATE_PHONE',
      {
        uz: `"${phone}" raqamli foydalanuvchi allaqachon mavjud`,
        ru: `Пользователь с номером "${phone}" уже существует`,
        en: `A user with phone "${phone}" already exists`,
      },
      { phone },
    );
  }
}

export class InvalidRoleCodesException extends AppException {
  constructor(codes: string[]) {
    super(
      HttpStatus.BAD_REQUEST,
      'USER_INVALID_ROLE_CODES',
      {
        uz: `Noto'g'ri rol kodi: ${codes.join(', ')}`,
        ru: `Неверный код роли: ${codes.join(', ')}`,
        en: `Invalid role code(s): ${codes.join(', ')}`,
      },
      { codes },
    );
  }
}

export class UserAlreadyActiveException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'USER_ALREADY_ACTIVE', {
      uz: 'Foydalanuvchi allaqachon faol',
      ru: 'Пользователь уже активен',
      en: 'User is already active',
    });
  }
}

export class UserAlreadyInactiveException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'USER_ALREADY_INACTIVE', {
      uz: 'Foydalanuvchi allaqachon nofaol',
      ru: 'Пользователь уже неактивен',
      en: 'User is already inactive',
    });
  }
}

export class CannotDeactivateSelfException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'USER_CANNOT_DEACTIVATE_SELF', {
      uz: "O'zingizni faolsizlantira olmaysiz",
      ru: 'Вы не можете деактивировать самого себя',
      en: 'You cannot deactivate your own account',
    });
  }
}

export class CannotDeleteSelfException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'USER_CANNOT_DELETE_SELF', {
      uz: "O'z hisobingizni o'chira olmaysiz",
      ru: 'Вы не можете удалить собственную учётную запись',
      en: 'You cannot delete your own account',
    });
  }
}

/**
 * Same SEC-020..024 reasoning as CannotGrantOwnerRoleException: `users.delete`
 * is also held by SALES_DIRECTOR, and deleting the Owner is at least as
 * powerful as granting yourself their role.
 */
export class CannotDeleteOwnerException extends AppException {
  constructor() {
    super(HttpStatus.FORBIDDEN, 'USER_CANNOT_DELETE_OWNER', {
      uz: 'Faqat Egasi boshqa Egani o‘chira oladi',
      ru: 'Только Владелец может удалить другого Владельца',
      en: 'Only an Owner can delete another Owner',
    });
  }
}

/** `?hard=true` was requested for a user that still owns business records — physical deletion would break referential integrity (and AuditLog is append-only, so its rows can't be detached). */
export class UserHasReferencesException extends AppException {
  constructor(references: Record<string, number>) {
    super(
      HttpStatus.CONFLICT,
      'USER_HAS_REFERENCES',
      {
        uz: "Foydalanuvchida bog'liq yozuvlar bor, uni butunlay o'chirib bo'lmaydi",
        ru: 'У пользователя есть связанные записи — физическое удаление невозможно',
        en: 'The user still has related records and cannot be physically deleted',
      },
      { references },
    );
  }
}

export class CannotGrantOwnerRoleException extends AppException {
  constructor() {
    super(HttpStatus.FORBIDDEN, 'USER_CANNOT_GRANT_OWNER_ROLE', {
      uz: "Faqat Egasi boshqa foydalanuvchiga Egasi rolini bera oladi",
      ru: 'Только Владелец может назначить роль Владельца другому пользователю',
      en: 'Only an Owner can grant the Owner role to a user',
    });
  }
}

export class CannotSetOthersPasswordException extends AppException {
  constructor() {
    super(HttpStatus.FORBIDDEN, 'USER_CANNOT_SET_OTHERS_PASSWORD', {
      uz: "Faqat Egasi boshqa foydalanuvchining parolini o'zgartira oladi",
      ru: 'Только Владелец может изменить пароль другого пользователя',
      en: "Only an Owner can change another user's password",
    });
  }
}

export class LastOwnerException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'USER_LAST_OWNER', {
      uz: "Kompaniyaning yagona Egasini o'chirib, faolsizlantirib yoki rolini o'zgartirib bo'lmaydi",
      ru: 'Нельзя удалить, деактивировать или изменить роль единственного Владельца компании',
      en: "The company's sole remaining Owner cannot be deleted, deactivated or have their role changed",
    });
  }
}
