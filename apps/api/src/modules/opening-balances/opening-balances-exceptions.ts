import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class OpeningBatchNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'OPENING_BATCH_NOT_FOUND', {
      uz: "Boshlang'ich qoldiq paketi topilmadi",
      ru: 'Пакет начальных остатков не найден',
      en: 'Opening balance batch not found',
    });
  }
}

export class OpeningEmptyFileException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'OPENING_EMPTY_FILE', {
      uz: "Faylda ma'lumot qatori yo'q",
      ru: 'В файле нет строк с данными',
      en: 'The file has no data rows',
    });
  }
}

export class OpeningBatchNotPreviewedException extends AppException {
  constructor(status: string) {
    super(
      HttpStatus.CONFLICT,
      'OPENING_BATCH_NOT_PREVIEWED',
      {
        uz: "Paket allaqachon o'tkazilgan yoki bekor qilingan — faqat PREVIEWED paketni o'tkazish mumkin",
        ru: 'Пакет уже проведён или аннулирован — провести можно только пакет в статусе PREVIEWED',
        en: 'The batch is already posted or voided — only a PREVIEWED batch can be posted',
      },
      { status },
    );
  }
}

export class OpeningBatchNotPostedException extends AppException {
  constructor(status: string) {
    super(
      HttpStatus.CONFLICT,
      'OPENING_BATCH_NOT_POSTED',
      {
        uz: "Faqat o'tkazilgan (POSTED) paketni bekor qilish mumkin",
        ru: 'Аннулировать можно только проведённый (POSTED) пакет',
        en: 'Only a POSTED batch can be voided',
      },
      { status },
    );
  }
}

export class OpeningSignOffRequiredException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'OPENING_SIGN_OFF_REQUIRED', {
      uz: "O'tkazish uchun operator tasdig'i (signOff) majburiy",
      ru: 'Для проведения обязательно подтверждение оператора (signOff)',
      en: 'Operator sign-off (signOff) is required to post',
    });
  }
}

export class OpeningTotalsMismatchException extends AppException {
  constructor(expected: Record<string, string>, provided: Record<string, string>) {
    super(
      HttpStatus.CONFLICT,
      'OPENING_TOTALS_MISMATCH',
      {
        uz: "1C nazorat jamilari ko'rib chiqilgan fayl jamilariga aniq teng emas",
        ru: 'Контрольные итоги 1С не совпадают точно с итогами проверенного файла',
        en: '1C control totals do not exactly match the previewed file totals',
      },
      { expected, provided },
    );
  }
}

export class OpeningPreviewHasErrorsException extends AppException {
  constructor(invalidCount: number) {
    super(
      HttpStatus.CONFLICT,
      'OPENING_PREVIEW_HAS_ERRORS',
      {
        uz: "Faylda xato qatorlar bor — tuzatib, qayta yuklang. Boshlang'ich qoldiq qisman o'tkazilmaydi",
        ru: 'В файле есть ошибочные строки — исправьте и загрузите заново. Начальные остатки не проводятся частично',
        en: 'The file has invalid rows — fix and re-upload it. Opening balances are never posted partially',
      },
      { invalidCount },
    );
  }
}

export class OpeningConflictException extends AppException {
  constructor(rows: number[]) {
    super(
      HttpStatus.CONFLICT,
      'OPENING_CONFLICT',
      {
        uz: "Ko'rib chiqishdan keyin ma'lumot o'zgargan (mijozda hisob yozuvlari yoki juftlikda harakat paydo bo'lgan, yoki yozuv o'chirilgan) — faylni qayta yuklang",
        ru: 'Данные изменились после проверки (у клиента появились проводки, по паре — движения, или запись удалена) — загрузите файл заново',
        en: 'Data changed after preview (customer ledger entries or pair movements appeared, or a record was removed) — re-upload the file',
      },
      { rows: rows.slice(0, 100), count: rows.length },
    );
  }
}

export class OpeningStockAlreadyExistsException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'OPENING_STOCK_ALREADY_EXISTS', {
      uz: "Bu mahsulot va ombor uchun boshlang'ich qoldiq allaqachon mavjud — avval o'sha paketni bekor qiling",
      ru: 'Начальный остаток для этого товара и склада уже существует — сначала аннулируйте тот пакет',
      en: 'Opening stock already exists for this product and warehouse — void that batch first',
    });
  }
}

export class OpeningDocDateAfterAsOfException extends AppException {
  constructor(rows: number[]) {
    super(
      HttpStatus.BAD_REQUEST,
      'OPENING_DOC_DATE_AFTER_AS_OF',
      {
        uz: "Hujjat sanasi (docDate) qoldiq sanasidan (asOfDate) keyin bo'lishi mumkin emas",
        ru: 'Дата документа (docDate) не может быть позже даты остатков (asOfDate)',
        en: 'Document date (docDate) cannot be after the as-of date (asOfDate)',
      },
      { rows: rows.slice(0, 100), count: rows.length },
    );
  }
}

export class OpeningAsOfInFutureException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'OPENING_AS_OF_IN_FUTURE', {
      uz: "Qoldiq sanasi (asOfDate) kelajakda bo'lishi mumkin emas",
      ru: 'Дата остатков (asOfDate) не может быть в будущем',
      en: 'The as-of date (asOfDate) cannot be in the future',
    });
  }
}

/** Void refused: a ledger row of the batch was used later. States the fact only — the correction path is a pending business decision. */
export class OpeningBatchTouchedException extends AppException {
  constructor(reason: 'INVOICE_ALLOCATED' | 'PAYMENT_USED' | 'STOCK_MOVED') {
    super(
      HttpStatus.CONFLICT,
      'OPENING_BATCH_TOUCHED',
      {
        uz: "Paketni bekor qilib bo'lmaydi: uning hujjatlari yoki qoldig'i keyingi operatsiyalarda ishlatilgan (to'lov taqsimoti yoki ombor harakati bor)",
        ru: 'Пакет нельзя аннулировать: его документы или остатки уже использованы в последующих операциях (есть распределение оплаты или движение склада)',
        en: 'The batch cannot be voided: its documents or stock were used by later operations (a payment allocation or a stock movement exists)',
      },
      { reason },
    );
  }
}

export class OpeningVoidReasonRequiredException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'OPENING_VOID_REASON_REQUIRED', {
      uz: "Bekor qilish sababi majburiy (3–500 belgi)",
      ru: 'Причина аннулирования обязательна (3–500 символов)',
      en: 'A void reason is required (3–500 characters)',
    });
  }
}
