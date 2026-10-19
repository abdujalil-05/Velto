import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class ExportJobNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'EXPORT_JOB_NOT_FOUND', {
      uz: "Eksport topshirig'i topilmadi",
      ru: 'Задача экспорта не найдена',
      en: 'Export job not found',
    });
  }
}

export class ExportPeriodNotClosedException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'EXPORT_PERIOD_NOT_CLOSED', {
      uz: 'Eksport davri kecha (kompaniya vaqt zonasi bo\'yicha) yoki undan oldin tugashi kerak',
      ru: 'Период экспорта должен заканчиваться вчера (по часовому поясу компании) или раньше',
      en: 'The export period must end yesterday (company timezone) or earlier',
    });
  }
}

export class InvalidExportPeriodException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'EXPORT_INVALID_PERIOD', {
      uz: '"Dan" sanasi "Gacha" sanasidan keyin bo\'lishi mumkin emas',
      ru: 'Дата "с" не может быть позже даты "по"',
      en: 'The "from" date cannot be after the "to" date',
    });
  }
}
