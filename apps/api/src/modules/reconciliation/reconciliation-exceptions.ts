import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class ReconciliationFindingNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'RECONCILIATION_FINDING_NOT_FOUND', {
      uz: 'Solishtirish natijasi topilmadi',
      ru: 'Расхождение сверки не найдено',
      en: 'Reconciliation finding not found',
    });
  }
}

export class ReconciliationFindingAlreadyFixedException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'RECONCILIATION_FINDING_ALREADY_FIXED', {
      uz: 'Bu farq allaqachon tuzatilgan',
      ru: 'Это расхождение уже исправлено',
      en: 'This finding has already been fixed',
    });
  }
}

/** Another detection run (or a fix) for this company holds the reconciliation lock. */
export class ReconciliationBusyException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'RECONCILIATION_BUSY', {
      uz: 'Solishtirish hozir bajarilmoqda, birozdan keyin qayta urinib ko‘ring',
      ru: 'Сверка уже выполняется, повторите попытку позже',
      en: 'A reconciliation is already in progress, try again later',
    });
  }
}

/** detect() needs one consistent snapshot (REPEATABLE READ/SERIALIZABLE) — programming error otherwise. */
export class ReconciliationSnapshotRequiredException extends AppException {
  constructor(isolation: string) {
    super(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'RECONCILIATION_SNAPSHOT_REQUIRED',
      {
        uz: 'Solishtirish izchil snapshot tranzaksiyasini talab qiladi',
        ru: 'Сверка требует транзакции с согласованным снимком',
        en: 'Reconciliation requires a consistent-snapshot transaction',
      },
      { isolation },
    );
  }
}

/**
 * The ledger itself yields an impossible stock state (negative on-hand or
 * reserved, or reserved > on-hand). Copying it into StockLevel would hide a
 * ledger defect — refused; needs a manual ledger correction (ADJUST/reversal).
 */
export class ReconciliationLedgerInvalidException extends AppException {
  constructor(expectedOnHand: string, expectedReserved: string) {
    super(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'RECONCILIATION_LEDGER_INVALID',
      {
        uz: 'Harakatlar jurnali noto‘g‘ri qoldiq beradi — avval jurnalni tuzating',
        ru: 'Журнал движений даёт недопустимый остаток — сначала исправьте журнал',
        en: 'The movement ledger yields an invalid stock state — correct the ledger first',
      },
      { expectedOnHand, expectedReserved },
    );
  }
}
