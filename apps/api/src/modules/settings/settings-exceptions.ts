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
