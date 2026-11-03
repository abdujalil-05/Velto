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

export class ImportFileTooLargeException extends AppException {
  constructor(reason: string) {
    super(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'IMPORT_FILE_TOO_LARGE',
      {
        uz: "Fayl juda katta yoki murakkab — qatorlar/ustunlar chegarasidan oshdi",
        ru: 'Файл слишком большой или сложный — превышены лимиты строк/столбцов',
        en: 'File is too large or complex — row/column limits exceeded',
      },
      { reason },
    );
  }
}

export class ImportQueueUnavailableException extends AppException {
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'IMPORT_QUEUE_UNAVAILABLE', {
      uz: "Navbat vaqtincha mavjud emas — importni keyinroq qayta tasdiqlang",
      ru: 'Очередь временно недоступна — повторите подтверждение импорта позже',
      en: 'Queue temporarily unavailable — please confirm the import again later',
    });
  }
}

/** Stable, non-leaky failure payload stored in ImportJob.errorLog. */
export const IMPORT_COMMIT_FAILED = {
  code: 'IMPORT_COMMIT_FAILED',
  message: {
    uz: "Importni bajarishda xatolik yuz berdi. Qayta urinib ko'ring yoki qo'llab-quvvatlashga murojaat qiling",
    ru: 'Ошибка при выполнении импорта. Повторите попытку или обратитесь в поддержку',
    en: 'The import failed. Please retry or contact support',
  },
};

/** ADR-064b: stored in ImportJob.errorLog when automatic recovery attempts are exhausted. */
export const IMPORT_RECOVERY_EXHAUSTED = {
  code: 'IMPORT_RECOVERY_EXHAUSTED',
  message: {
    uz: "Import avtomatik qayta urinishlardan keyin ham yakunlanmadi. Qo'llab-quvvatlashga murojaat qiling",
    ru: 'Импорт не завершён после автоматических повторных попыток. Обратитесь в поддержку',
    en: 'The import did not finish after automatic recovery attempts. Please contact support',
  },
};
