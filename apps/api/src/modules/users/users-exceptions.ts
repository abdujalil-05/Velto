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
      uz: "Kompaniyaning yagona Egasini faolsizlantirib yoki rolini o'zgartirib bo'lmaydi",
      ru: 'Нельзя деактивировать или изменить роль единственного Владельца компании',
      en: "The company's sole remaining Owner cannot be deactivated or have their role changed",
    });
  }
}
