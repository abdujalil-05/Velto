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
      uz: 'Ichki hisob topilmadi',
      ru: 'Внутренний счёт не найден',
      en: 'Internal invoice not found',
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
        uz: `"${invoiceNumber}" ichki hisobining qoldig'i ${outstanding}, so'ralgan ${requested}`,
        ru: `Остаток внутреннего счёта "${invoiceNumber}" составляет ${outstanding}, запрошено ${requested}`,
        en: `Internal invoice "${invoiceNumber}" has ${outstanding} outstanding, but ${requested} was requested`,
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

/**
 * F2.1 / ADR-029: allocate and reverse both need a POSTED payment (REVERSED
 * has no advance; PENDING_HANDOVER/REJECTED never touched the ledger).
 */
export class PaymentNotPostedException extends AppException {
  constructor(status: string) {
    super(
      HttpStatus.CONFLICT,
      'PAYMENT_NOT_POSTED',
      {
        uz: "Bu amal faqat o'tkazilgan (POSTED) to'lov uchun mumkin",
        ru: 'Это действие доступно только для проведённого (POSTED) платежа',
        en: 'This action is only allowed for a POSTED payment',
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

/** ADR-029: only a PENDING_HANDOVER payment can be accepted or rejected (second accept/reject included). */
export class PaymentNotPendingHandoverException extends AppException {
  constructor(status: string) {
    super(
      HttpStatus.CONFLICT,
      'PAYMENT_NOT_PENDING_HANDOVER',
      {
        uz: "To'lov topshirishni kutmayapti — uni qabul qilish yoki rad etish mumkin emas",
        ru: 'Платёж не ожидает сдачи в кассу — принять или отклонить его нельзя',
        en: 'Payment is not pending handover and cannot be accepted or rejected',
      },
      { status },
    );
  }
}

/** ADR-029: the collector of the cash may never accept/reject their own handover (four-eyes). */
export class PaymentHandoverSelfResolveException extends AppException {
  constructor() {
    super(HttpStatus.FORBIDDEN, 'PAYMENT_HANDOVER_SELF_RESOLVE', {
      uz: "O'zingiz yig'gan to'lovni o'zingiz qabul qila yoki rad eta olmaysiz",
      ru: 'Нельзя принять или отклонить платёж, который вы собрали сами',
      en: 'You cannot accept or reject a payment you collected yourself',
    });
  }
}

/** ADR-029: accepting cash requires the acceptor's own open cash session. */
export class PaymentHandoverNoOpenCashSessionException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'PAYMENT_HANDOVER_CASH_SESSION_NOT_OPEN', {
      uz: "Naqd pulni qabul qilish uchun avval kassa smenasini oching",
      ru: 'Чтобы принять наличные, сначала откройте кассовую смену',
      en: 'Open a cash session before accepting a cash handover',
    });
  }
}

/** ADR-029: a rejected handover must carry a reason (audited). */
export class PaymentHandoverRejectReasonRequiredException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'PAYMENT_HANDOVER_REJECT_REASON_REQUIRED', {
      uz: "Rad etish sababi kamida 3 belgidan iborat bo'lishi kerak",
      ru: 'Причина отклонения должна содержать не менее 3 символов',
      en: 'Rejection reason must be at least 3 characters',
    });
  }
}

/** ADR-029: agent cash is in transit (PENDING_HANDOVER) — it cannot be allocated until a cashier accepts it. */
export class PaymentPendingHandoverAllocationException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'PAYMENT_PENDING_HANDOVER_NO_ALLOCATION', {
      uz: "Agent yig'gan naqd pul kassaga topshirilguncha taqsimlanmaydi",
      ru: 'Наличные, собранные агентом, не распределяются до сдачи в кассу',
      en: 'Agent-collected cash cannot be allocated until it is handed over',
    });
  }
}

/** ADR-029: POST /payments/statuses takes 1..100 ids + clientIds in total. */
export class PaymentStatusesLimitException extends AppException {
  constructor(max: number) {
    super(
      HttpStatus.BAD_REQUEST,
      'PAYMENT_STATUSES_LIMIT',
      {
        uz: `1 dan ${max} tagacha to'lov identifikatori yuboring`,
        ru: `Передайте от 1 до ${max} идентификаторов платежей`,
        en: `Send between 1 and ${max} payment identifiers`,
      },
      { max },
    );
  }
}

/** 10.4: clientId reused with different payment content. Details echo only the caller's own clientId — never the stored payment. */
export class PaymentIdempotencyConflictException extends AppException {
  constructor(clientId: string) {
    super(
      HttpStatus.CONFLICT,
      'PAYMENT_IDEMPOTENCY_CONFLICT',
      {
        uz: "Bu clientId boshqa mazmundagi to'lov uchun allaqachon ishlatilgan",
        ru: 'Этот clientId уже использован для платежа с другим содержимым',
        en: 'This clientId was already used for a payment with different content',
      },
      { clientId },
    );
  }
}

/**
 * 10.4 / PO decision: the stored Payment columns match the replay, but the
 * original request's allocation mode cannot be proven from immutable data
 * (legacy payment without a create-time request record). Never a silent replay.
 */
export class PaymentIdempotencyUnverifiableException extends AppException {
  constructor(clientId: string) {
    super(
      HttpStatus.CONFLICT,
      'PAYMENT_IDEMPOTENCY_UNVERIFIABLE',
      {
        uz: "Bu clientId bilan to'lov allaqachon mavjud, lekin asl so'rovni ishonchli tekshirib bo'lmaydi. Takroriy to'lov yaratilmadi — buxgalter bilan qo'lda solishtiring",
        ru: 'Платёж с этим clientId уже существует, но исходный запрос невозможно достоверно проверить. Повторный платёж не создан — выполните ручную сверку с бухгалтером',
        en: 'A payment with this clientId already exists, but the original request cannot be reliably verified. No duplicate payment was created — reconcile manually with the accountant',
      },
      { clientId },
    );
  }
}

export class PaymentOpeningNotReversibleException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'PAYMENT_OPENING_NOT_REVERSIBLE', {
      uz: "Boshlang'ich qoldiq to'lovini bu yerda bekor qilib yoki taqsimlab bo'lmaydi; faqat boshlang'ich qoldiq partiyasini bekor qilish orqali",
      ru: 'Платёж начального остатка нельзя отменить или распределить здесь; только через аннулирование партии начальных остатков',
      en: 'An opening balance payment cannot be reversed or allocated here; void the opening batch instead',
    });
  }
}

/** PO 2026-11-02: no Payment with this clientId in the caller's company (RLS) — nothing to reconcile. */
export class PaymentReconciliationPaymentNotFoundException extends AppException {
  constructor(clientId: string) {
    super(
      HttpStatus.NOT_FOUND,
      'PAYMENT_RECONCILIATION_PAYMENT_NOT_FOUND',
      {
        uz: "Bu clientId bilan to'lov topilmadi",
        ru: 'Платёж с этим clientId не найден',
        en: 'No payment found for this clientId',
      },
      { clientId },
    );
  }
}

/**
 * PO 2026-11-02: the Payment exists but no `payment.create_rejected` audit row
 * proves a rejected replay — nothing to reconcile. NOT_POSTED is never
 * inferred from the absence of evidence.
 */
export class PaymentReconciliationNoRejectedIntentException extends AppException {
  constructor(clientId: string) {
    super(
      HttpStatus.CONFLICT,
      'PAYMENT_RECONCILIATION_NO_REJECTED_INTENT',
      {
        uz: "Bu clientId bo'yicha rad etilgan takroriy to'lov qayd etilmagan — solishtirish talab qilinmaydi",
        ru: 'По этому clientId не зафиксирован отклонённый повторный платёж — сверка не требуется',
        en: 'No rejected payment replay is recorded for this clientId — nothing to reconcile',
      },
      { clientId },
    );
  }
}

/** PO 2026-11-02: a different outcome is already recorded; decisions are append-only and never overwritten. */
export class PaymentReconciliationContradictionException extends AppException {
  constructor(clientId: string, existingOutcome: string) {
    super(
      HttpStatus.CONFLICT,
      'PAYMENT_RECONCILIATION_CONTRADICTION',
      {
        uz: "Bu clientId bo'yicha boshqa qaror allaqachon qayd etilgan; uni o'zgartirib bo'lmaydi",
        ru: 'По этому clientId уже зафиксировано другое решение; изменить его нельзя',
        en: 'A different decision is already recorded for this clientId; it cannot be changed',
      },
      { clientId, existingOutcome },
    );
  }
}

/** PO 2026-11-02: NOT_POSTED_CONFIRMED requires an evidence reference (bank/cash document, ticket). */
export class PaymentReconciliationEvidenceRequiredException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'PAYMENT_RECONCILIATION_EVIDENCE_REQUIRED', {
      uz: "\"To'lov o'tkazilmagan\" qarori uchun dalil havolasi (evidenceRef) majburiy",
      ru: 'Для решения «платёж не проведён» обязательна ссылка на подтверждение (evidenceRef)',
      en: 'An evidence reference (evidenceRef) is required for NOT_POSTED_CONFIRMED',
    });
  }
}
