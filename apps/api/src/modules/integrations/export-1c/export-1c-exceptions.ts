import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../../common/errors/app-exception';

export class ExportNotDownloadableException extends AppException {
  constructor(status: string) {
    super(
      HttpStatus.CONFLICT,
      'EXPORT_NOT_DOWNLOADABLE',
      {
        uz: 'Fayl hali tayyor emas yoki yuklab olish mumkin emas',
        ru: 'Файл ещё не готов или недоступен для скачивания',
        en: 'The file is not ready or cannot be downloaded',
      },
      { status },
    );
  }
}

export class ExportAckNotAllowedException extends AppException {
  constructor(status: string) {
    super(
      HttpStatus.CONFLICT,
      'EXPORT_ACK_NOT_ALLOWED',
      {
        uz: 'Eksport faqat GENERATED holatida tasdiqlanadi (allaqachon tasdiqlangan bo\'lishi mumkin)',
        ru: 'Экспорт можно подтвердить только в статусе GENERATED (возможно, уже подтверждён)',
        en: 'An export can be acknowledged only in GENERATED status (it may already be acknowledged)',
      },
      { status },
    );
  }
}

export class ExportAckChecksumMismatchException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'EXPORT_ACK_CHECKSUM_MISMATCH', {
      uz: 'Nazorat summasi (SHA-256) fayl xeshiga mos kelmaydi',
      ru: 'Контрольная сумма (SHA-256) не совпадает с хешем файла',
      en: 'The checksum (SHA-256) does not match the file hash',
    });
  }
}

export class ExportAckNoteRequiredException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'EXPORT_ACK_NOTE_REQUIRED', {
      uz: "Rad etishda izoh kamida 3 belgidan iborat bo'lishi kerak",
      ru: 'При отклонении комментарий должен содержать не менее 3 символов',
      en: 'A rejection requires a note of at least 3 characters',
    });
  }
}

export class ExportActiveLimitException extends AppException {
  constructor(limit: number) {
    super(
      HttpStatus.TOO_MANY_REQUESTS,
      'EXPORT_ACTIVE_LIMIT',
      {
        uz: `Bir vaqtda ${limit} tadan ortiq faol 1C eksport bo'lishi mumkin emas`,
        ru: `Одновременно допускается не более ${limit} активных экспортов 1С`,
        en: `No more than ${limit} concurrent 1C exports are allowed`,
      },
      { limit },
    );
  }
}

export class ExportLegacyNoChecksumException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'EXPORT_LEGACY_NO_CHECKSUM', {
      uz: "Bu eski eksport — tasdiqlash/yuklash uchun qayta eksport qiling",
      ru: 'Это устаревший экспорт — для подтверждения/скачивания выполните экспорт заново',
      en: 'This is a legacy export — re-export to confirm/download',
    });
  }
}
