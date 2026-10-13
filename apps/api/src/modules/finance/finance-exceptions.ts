import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class PaymentNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'PAYMENT_NOT_FOUND', {
      uz: "To'lov topilmadi",
      ru: 'Платеж не найден',
      en: 'Payment not found',
    });
  }
}

export class InvoiceNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'INVOICE_NOT_FOUND', {
      uz: 'Hisob-faktura topilmadi',
      ru: 'Счёт-фактура не найден',
      en: 'Invoice not found',
    });
  }
}

export class InvalidPaymentAmountException extends AppException {
  constructor(message: string) {
    super(HttpStatus.BAD_REQUEST, 'PAYMENT_INVALID_AMOUNT', {
      uz: message,
      ru: 'Некорректная сумма платежа',
      en: 'Invalid payment amount',
    });
  }
}

export class AllocationExceedsInvoiceException extends AppException {
  constructor(invoiceNumber: string, outstanding: string, requested: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'PAYMENT_ALLOCATION_EXCEEDS_INVOICE',
      {
        uz: `"${invoiceNumber}" fakturasining qoldig'i ${outstanding}, so'ralgan ${requested}`,
        ru: `Остаток счёта "${invoiceNumber}" составляет ${outstanding}, запрошено ${requested}`,
        en: `Invoice "${invoiceNumber}" has ${outstanding} outstanding, but ${requested} was requested`,
      },
      { invoiceNumber, outstanding, requested },
    );
  }
}

export class AllocationExceedsPaymentException extends AppException {
  constructor(paymentAmount: string, totalAllocated: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'PAYMENT_ALLOCATION_EXCEEDS_PAYMENT',
      {
        uz: `To'lov summasi ${paymentAmount}, taqsimlangan summa ${totalAllocated}dan katta bo'lishi mumkin emas`,
        ru: `Сумма платежа ${paymentAmount} — распределённая сумма не может превышать ${totalAllocated}`,
        en: `Payment amount is ${paymentAmount} — allocations cannot exceed ${totalAllocated}`,
      },
      { paymentAmount, totalAllocated },
    );
  }
}

export class NoOpenCashSessionException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'CASH_SESSION_NOT_OPEN', {
      uz: 'Ochiq kassa smenasi topilmadi',
      ru: 'Нет открытой кассовой смены',
      en: 'No open cash session',
    });
  }
}

export class CashSessionAlreadyOpenException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'CASH_SESSION_ALREADY_OPEN', {
      uz: 'Sizda allaqachon ochiq kassa smenasi bor',
      ru: 'У вас уже есть открытая кассовая смена',
      en: 'You already have an open cash session',
    });
  }
}

/** F2.1: a payment is reversed at most once (PaymentReversal is unique per payment). */
export class PaymentAlreadyReversedException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'PAYMENT_ALREADY_REVERSED', {
      uz: "To'lov allaqachon qaytarilgan",
      ru: 'Платеж уже сторнирован',
      en: 'Payment has already been reversed',
    });
  }
}

export class PaymentReversalReasonRequiredException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'PAYMENT_REVERSAL_REASON_REQUIRED', {
      uz: "Qaytarish sababi kamida 3 belgidan iborat bo'lishi kerak",
      ru: 'Причина сторнирования должна содержать не менее 3 символов',
      en: 'Reversal reason must be at least 3 characters',
    });
  }
}

/** F2.1: a CASH payment counted in an already-closed cash session cannot be reversed. */
export class PaymentInClosedCashSessionException extends AppException {
  constructor(cashSessionId: string) {
    super(
      HttpStatus.CONFLICT,
      'PAYMENT_REVERSAL_CASH_SESSION_CLOSED',
      {
        uz: "To'lov yopilgan kassa smenasiga kiritilgan — uni qaytarib bo'lmaydi",
        ru: 'Платеж учтён в закрытой кассовой смене — сторнирование невозможно',
        en: 'Payment belongs to a closed cash session and cannot be reversed',
      },
      { cashSessionId },
    );
  }
}

/** F2.1: a payment inside the period of a non-failed 1C export job cannot be reversed. */
export class PaymentExportedTo1cException extends AppException {
  constructor(exportJobId: string) {
    super(
      HttpStatus.CONFLICT,
      'PAYMENT_REVERSAL_EXPORTED_1C',
      {
        uz: "To'lov 1C ga eksport qilingan davrga tushadi — uni qaytarib bo'lmaydi",
        ru: 'Платеж входит в период выгрузки в 1С — сторнирование невозможно',
        en: 'Payment falls within a 1C export period and cannot be reversed',
      },
      { exportJobId },
    );
  }
}

/** F2.1: only a POSTED payment's advance can be allocated later (REVERSED has none). */
export class PaymentNotPostedException extends AppException {
  constructor(status: string) {
    super(
      HttpStatus.CONFLICT,
      'PAYMENT_NOT_POSTED',
      {
        uz: "Faqat o'tkazilgan (POSTED) to'lovni taqsimlash mumkin",
        ru: 'Распределять можно только проведённый (POSTED) платёж',
        en: 'Only a POSTED payment can be allocated',
      },
      { status },
    );
  }
}

/** F2.1: a later manual allocation is capped by the payment's unallocated remainder (advance). */
export class AllocationExceedsAdvanceException extends AppException {
  constructor(advance: string, requested: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'PAYMENT_ALLOCATION_EXCEEDS_ADVANCE',
      {
        uz: `To'lovning taqsimlanmagan qoldig'i (avans) ${advance}, so'ralgan ${requested}`,
        ru: `Нераспределённый остаток платежа (аванс) ${advance}, запрошено ${requested}`,
        en: `Payment unallocated remainder (advance) is ${advance}, but ${requested} was requested`,
      },
      { advance, requested },
    );
  }
}
