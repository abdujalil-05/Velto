import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class CustomerNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'CUSTOMER_NOT_FOUND', {
      uz: 'Mijoz topilmadi',
      ru: 'Клиент не найден',
      en: 'Customer not found',
    });
  }
}

export class DuplicateCustomerCodeException extends AppException {
  constructor(code: string) {
    super(
      HttpStatus.CONFLICT,
      'CUSTOMER_DUPLICATE_CODE',
      {
        uz: `"${code}" kodli mijoz allaqachon mavjud`,
        ru: `Клиент с кодом "${code}" уже существует`,
        en: `A customer with code "${code}" already exists`,
      },
      { code },
    );
  }
}

export class OutletNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'OUTLET_NOT_FOUND', {
      uz: 'Savdo nuqtasi topilmadi',
      ru: 'Торговая точка не найдена',
      en: 'Outlet not found',
    });
  }
}

export class PriceListNotFoundForCustomerException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'PRICE_LIST_NOT_FOUND', {
      uz: "Narx ro'yxati topilmadi",
      ru: 'Прайс-лист не найден',
      en: 'Price list not found',
    });
  }
}

export class CustomerAlreadyBlockedException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'CUSTOMER_ALREADY_BLOCKED', {
      uz: 'Mijoz allaqachon bloklangan',
      ru: 'Клиент уже заблокирован',
      en: 'Customer is already blocked',
    });
  }
}

export class CustomerNotBlockedException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'CUSTOMER_NOT_BLOCKED', {
      uz: 'Mijoz bloklanmagan',
      ru: 'Клиент не заблокирован',
      en: 'Customer is not blocked',
    });
  }
}

export class CustomerHasOutstandingBalanceException extends AppException {
  constructor(balance: string, blockers?: CustomerDeleteBlockers) {
    super(
      HttpStatus.CONFLICT,
      'CUSTOMER_HAS_OUTSTANDING_BALANCE',
      {
        uz: `Mijozning to'lanmagan qarzi bor (${balance}), uni o'chirib bo'lmaydi`,
        ru: `У клиента есть непогашенный баланс (${balance}) — удаление невозможно`,
        en: `The customer has an outstanding balance (${balance}) and cannot be deleted`,
      },
      { balance, ...(blockers ? { blockers } : {}) },
    );
  }
}

/** Negative ledger balance = advance/credit the company owes back; deleting would lose it (§6.5). */
export class CustomerHasCreditBalanceException extends AppException {
  constructor(credit: string, blockers?: CustomerDeleteBlockers) {
    super(
      HttpStatus.CONFLICT,
      'CUSTOMER_HAS_CREDIT_BALANCE',
      {
        uz: `Mijozda qaytarilishi kerak bo'lgan avans/kredit bor (${credit}), uni o'chirib bo'lmaydi`,
        ru: `У клиента есть аванс/кредит к возврату (${credit}) — удаление невозможно`,
        en: `The customer has an advance/credit balance to be returned (${credit}) and cannot be deleted`,
      },
      { credit, ...(blockers ? { blockers } : {}) },
    );
  }
}

/** ADR-029: agent cash awaiting cashier handover is not in the ledger yet; deleting the customer would orphan it. */
export class CustomerHasPendingHandoverException extends AppException {
  constructor(count: number, blockers?: CustomerDeleteBlockers) {
    super(
      HttpStatus.CONFLICT,
      'CUSTOMER_HAS_PENDING_HANDOVER',
      {
        uz: `Mijozda kassir qabul qilishini kutayotgan to'lov bor (${count} ta), uni o'chirib bo'lmaydi`,
        ru: `У клиента есть платежи, ожидающие приёма кассиром (${count}) — удаление невозможно`,
        en: `The customer has payments awaiting cashier handover (${count}) and cannot be deleted`,
      },
      { count, ...(blockers ? { blockers } : {}) },
    );
  }
}

/** ADR-061c: what still references a customer at delete time — counts/amounts only, no PII. */
export interface CustomerDeleteBlockers {
  /** Non-terminal orders per status (DRAFT..DELIVERED); CLOSED/CANCELLED never block. */
  orders: Record<string, number>;
  pendingHandover: number;
  /** Open receivables (live invoices − valid allocations), 2 dp. */
  debt: string;
  /** Unapplied POSTED payments (customer credit), 2 dp. */
  advance: string;
}

/** ADR-061c: open orders or a non-zero debt/advance (even if they net to 0) block the soft delete. */
export class CustomerHasOpenObligationsException extends AppException {
  constructor(blockers: CustomerDeleteBlockers) {
    super(
      HttpStatus.CONFLICT,
      'CUSTOMER_HAS_OPEN_OBLIGATIONS',
      {
        uz: "Mijozda yopilmagan buyurtmalar yoki ochiq qarz/avans bor, uni o'chirib bo'lmaydi",
        ru: 'У клиента есть незакрытые заказы или открытый долг/аванс — удаление невозможно',
        en: 'The customer has open orders or an open debt/advance and cannot be deleted',
      },
      { blockers },
    );
  }
}

/** ADR-061a: allocate/reverse/opening void on a soft-deleted customer would change a ledger nobody sees. */
export class CustomerDeletedException extends AppException {
  constructor(customerIds: string[]) {
    super(
      HttpStatus.CONFLICT,
      'CUSTOMER_DELETED',
      {
        uz: "Mijoz o'chirilgan: avval uni tiklang, so'ng moliyaviy amalni bajaring",
        ru: 'Клиент удалён: сначала восстановите его, затем выполните финансовую операцию',
        en: 'The customer is deleted: restore it before running a financial operation',
      },
      { customerIds },
    );
  }
}

/** ADR-061 restore: a live customer already holds the code; no auto-rename — rename one of them first. */
export class CustomerCodeConflictOnRestoreException extends AppException {
  constructor(code: string) {
    super(
      HttpStatus.CONFLICT,
      'CUSTOMER_CODE_CONFLICT_ON_RESTORE',
      {
        uz: `"${code}" kodli faol mijoz mavjud, o'chirilgan mijozni tiklab bo'lmaydi`,
        ru: `Активный клиент с кодом "${code}" уже существует — восстановление невозможно`,
        en: `An active customer with code "${code}" already exists; the deleted customer cannot be restored`,
      },
      { code },
    );
  }
}
