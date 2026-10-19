import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class CompanyExportActiveException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'COMPANY_EXPORT_ACTIVE', {
      uz: "Kompaniya ma'lumotlari eksporti allaqachon bajarilmoqda",
      ru: 'Экспорт данных компании уже выполняется',
      en: 'A company data export is already in progress',
    });
  }
}
