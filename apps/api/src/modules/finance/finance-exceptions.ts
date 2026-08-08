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
