import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class CompanyNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'COMPANY_NOT_FOUND', {
      uz: 'Kompaniya topilmadi',
      ru: 'Компания не найдена',
      en: 'Company not found',
    });
  }
}

export class InvalidTimeZoneException extends AppException {
  constructor(timezone: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'INVALID_TIMEZONE',
      {
        uz: "Vaqt mintaqasi noto'g'ri (IANA, masalan Asia/Tashkent)",
        ru: 'Неверный часовой пояс (IANA, например Asia/Tashkent)',
        en: 'Invalid time zone (IANA, e.g. Asia/Tashkent)',
      },
      { timezone },
    );
  }
}
