import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class NotificationNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'NOTIFICATION_NOT_FOUND', {
      uz: 'Bildirishnoma topilmadi',
      ru: 'Уведомление не найдено',
      en: 'Notification not found',
    });
  }
}
