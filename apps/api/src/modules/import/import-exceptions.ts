import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class ImportJobNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'IMPORT_JOB_NOT_FOUND', {
      uz: "Import topshirig'i topilmadi",
      ru: 'Задача импорта не найдена',
      en: 'Import job not found',
    });
  }
}

export class InvalidImportFileException extends AppException {
  constructor(reason: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'IMPORT_INVALID_FILE',
      {
        uz: "Fayl formati noto'g'ri — .xlsx shablonidan foydalaning",
        ru: 'Неверный формат файла — используйте шаблон .xlsx',
        en: 'Invalid file format — use the .xlsx template',
      },
      { reason },
    );
  }
}

export class ImportAlreadyConfirmedException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'IMPORT_ALREADY_CONFIRMED', {
      uz: "Bu import allaqachon tasdiqlangan yoki bajarilmoqda",
      ru: 'Этот импорт уже подтверждён или выполняется',
      en: 'This import has already been confirmed or is in progress',
    });
  }
}
