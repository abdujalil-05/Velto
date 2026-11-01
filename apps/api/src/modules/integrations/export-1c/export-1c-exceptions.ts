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

export const UNSUPPORTED_REASONS = ['DISCOUNT', 'VAT', 'QTY_X_PRICE_MISMATCH', 'UNIT', 'TOTAL_MISMATCH'] as const;
export type UnsupportedReason = (typeof UNSUPPORTED_REASONS)[number];

export interface UnsupportedViolation {
  invoiceId: string;
  invoiceNumber: string;
  /** null for document-level reasons (TOTAL_MISMATCH). */
  sku: string | null;
  reasons: UnsupportedReason[];
}

/** Max violations stored in ExportJob.errorLog / exception details; `total` carries the real count. */
export const UNSUPPORTED_DETAILS_CAP = 100;

/** ADR-059: the document cannot be represented correctly in mappingVersion 2 (strict reject, PO decision). */
export class ExportUnsupportedCombinationException extends AppException {
  static readonly CODE = '1C_EXPORT_UNSUPPORTED_COMBINATION';
  static readonly MESSAGES = {
        uz: "Hujjat(lar) joriy 1C formatida to'g'ri ifodalanmaydi (chegirma, QQS, birlik yoki summa nomuvofiqligi). Bunday hujjatlarsiz davrni tanlang va buxgalter bilan tekshiring",
        ru: 'Документ(ы) нельзя корректно представить в текущем формате 1С (скидка, НДС, единица или расхождение сумм). Исключите их из периода и проверьте с бухгалтером',
        en: 'Document(s) cannot be represented correctly in the current 1C format (discount, VAT, unit or amount mismatch). Narrow the period to exclude them and review with the accountant',
  };
  readonly violations: UnsupportedViolation[];
  readonly total: number;
  constructor(violations: UnsupportedViolation[]) {
    super(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ExportUnsupportedCombinationException.CODE,
      ExportUnsupportedCombinationException.MESSAGES,
      { total: violations.length, violations: violations.slice(0, UNSUPPORTED_DETAILS_CAP) },
    );
    this.violations = violations;
    this.total = violations.length;
  }
}

/** PO rule: EXCEL export is an informational register (no lines/VAT), so it can never be marked accounting-confirmed. */
export class ExportRegisterNotAcknowledgeableException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, '1C_EXPORT_REGISTER_NOT_ACKNOWLEDGEABLE', {
      uz: "Excel fayl axborot reyestri — buxgalteriya tomonidan tasdiqlanmaydi (1C importi uchun CSV/XML dan foydalaning)",
      ru: 'Excel — информационный реестр, он не подтверждается бухгалтерией (для импорта в 1С используйте CSV/XML)',
      en: 'The Excel file is an informational register and cannot be acknowledged as accounting-confirmed (use CSV/XML for 1C import)',
    });
  }
}
