import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class WarehouseNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'WAREHOUSE_NOT_FOUND', {
      uz: 'Ombor topilmadi',
      ru: 'Склад не найден',
      en: 'Warehouse not found',
    });
  }
}

export class StockProductNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'STOCK_PRODUCT_NOT_FOUND', {
      uz: 'Mahsulot topilmadi',
      ru: 'Товар не найден',
      en: 'Product not found',
    });
  }
}

/**
 * F-M03 / 8.3: "ikki foydalanuvchi oxirgi donani bir vaqtda so'rasa, biri
 * rezerv oladi, ikkinchisiga xato/ogohlantirish qaytadi" — this is that
 * error for the loser of the race.
 */
export class InsufficientStockException extends AppException {
  constructor(available: string, requested: string) {
    super(
      HttpStatus.CONFLICT,
      'STOCK_INSUFFICIENT',
      {
        uz: `Omborda yetarli qoldiq yo'q (mavjud: ${available}, so'ralgan: ${requested})`,
        ru: `Недостаточно товара на складе (доступно: ${available}, запрошено: ${requested})`,
        en: `Not enough stock available (available: ${available}, requested: ${requested})`,
      },
      { available, requested },
    );
  }
}

export class InvalidStockQtyException extends AppException {
  constructor(message: string) {
    super(HttpStatus.BAD_REQUEST, 'STOCK_INVALID_QTY', {
      uz: message,
      ru: 'Некорректное количество',
      en: 'Invalid quantity',
    });
  }
}

export class StockMovementNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'STOCK_MOVEMENT_NOT_FOUND', {
      uz: 'Ombor harakati topilmadi',
      ru: 'Складское движение не найдено',
      en: 'Stock movement not found',
    });
  }
}

/** F2.1: only manual RECEIVE/ADJUST movements that are not themselves reversals can be reversed. */
export class StockMovementNotReversibleException extends AppException {
  constructor(type: string, refType: string | null) {
    super(
      HttpStatus.CONFLICT,
      'STOCK_MOVEMENT_NOT_REVERSIBLE',
      {
        uz: "Bu ombor harakatini qaytarib bo'lmaydi (faqat qo'lda kiritilgan RECEIVE/ADJUST)",
        ru: 'Это складское движение нельзя сторнировать (только ручные RECEIVE/ADJUST)',
        en: 'This stock movement cannot be reversed (only manual RECEIVE/ADJUST)',
      },
      { type, refType },
    );
  }
}

export class StockMovementAlreadyReversedException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'STOCK_MOVEMENT_ALREADY_REVERSED', {
      uz: 'Ombor harakati allaqachon qaytarilgan',
      ru: 'Складское движение уже сторнировано',
      en: 'Stock movement has already been reversed',
    });
  }
}

export class StockReversalReasonRequiredException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'STOCK_REVERSAL_REASON_REQUIRED', {
      uz: "Qaytarish sababi kamida 3 belgidan iborat bo'lishi kerak",
      ru: 'Причина сторнирования должна содержать не менее 3 символов',
      en: 'Reversal reason must be at least 3 characters',
    });
  }
}

/** F2.1: reversing would take on-hand below zero or below what is reserved. */
export class StockReversalInsufficientException extends AppException {
  constructor(onHand: string, reserved: string, delta: string) {
    super(
      HttpStatus.CONFLICT,
      'STOCK_REVERSAL_INSUFFICIENT',
      {
        uz: `Qaytarish qoldiqni manfiy yoki rezervdan past qiladi (qoldiq: ${onHand}, rezerv: ${reserved}, o'zgarish: ${delta})`,
        ru: `Сторнирование сделает остаток отрицательным или ниже резерва (остаток: ${onHand}, резерв: ${reserved}, изменение: ${delta})`,
        en: `Reversal would take on-hand negative or below reserved (on hand: ${onHand}, reserved: ${reserved}, change: ${delta})`,
      },
      { onHand, reserved, delta },
    );
  }
}
