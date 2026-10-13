import { HttpStatus } from '@nestjs/common';
import { AppException } from './app-exception';

/** clientId already used by a different user — never reveals the foreign document or its id. */
export class ClientIdConflictException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'CLIENT_ID_CONFLICT', {
      uz: 'Bu clientId boshqa foydalanuvchi tomonidan ishlatilgan',
      ru: 'Этот clientId уже использован другим пользователем',
      en: 'This clientId is already used by another user',
    });
  }
}
