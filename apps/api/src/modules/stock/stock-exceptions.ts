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
