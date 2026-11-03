import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class SupplierNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'SUPPLIER_NOT_FOUND', {
      uz: 'Yetkazib beruvchi topilmadi',
      ru: 'Поставщик не найден',
      en: 'Supplier not found',
    });
  }
}

export class SupplierInactiveException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'SUPPLIER_INACTIVE', {
      uz: 'Yetkazib beruvchi faol emas',
      ru: 'Поставщик неактивен',
      en: 'Supplier is inactive',
    });
  }
}

export class PurchaseOrderNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'PURCHASE_ORDER_NOT_FOUND', {
      uz: 'Xarid buyurtmasi topilmadi',
      ru: 'Заказ поставщику не найден',
      en: 'Purchase order not found',
    });
  }
}

export class InvalidPurchaseOrderTransitionException extends AppException {
  constructor(from: string, to: string) {
    super(
      HttpStatus.CONFLICT,
      'PURCHASE_ORDER_INVALID_TRANSITION',
      {
        uz: `Xarid buyurtmasini "${from}" holatidan "${to}"ga o'tkazib bo'lmaydi`,
        ru: `Невозможно перевести заказ поставщику из "${from}" в "${to}"`,
        en: `Cannot move a purchase order from "${from}" to "${to}"`,
      },
      { from, to },
    );
  }
}

export class PurchaseOrderHasReceiptsException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'PURCHASE_ORDER_HAS_RECEIPTS', {
      uz: "Qisman qabul qilingan xarid buyurtmasini bekor qilib bo'lmaydi",
      ru: 'Нельзя отменить заказ поставщику, по которому уже есть приёмка',
      en: 'Cannot cancel a purchase order that already has received quantity',
    });
  }
}

export class PurchaseOrderNotReceivableException extends AppException {
  constructor(status: string) {
    super(
      HttpStatus.CONFLICT,
      'PURCHASE_ORDER_NOT_RECEIVABLE',
      {
        uz: `"${status}" holatidagi xarid buyurtmasi bo'yicha tovar qabul qilib bo'lmaydi`,
        ru: `Нельзя принять товар по заказу поставщику в статусе "${status}"`,
        en: `Cannot receive goods against a purchase order in status "${status}"`,
      },
      { status },
    );
  }
}

export class OverReceiptException extends AppException {
  constructor(purchaseOrderLineId: string, remaining: string, requested: string) {
    super(
      HttpStatus.CONFLICT,
      'GOODS_RECEIPT_OVER_RECEIPT',
      {
        uz: `Qabul qilinayotgan miqdor qoldiqdan ko'p (qolgan: ${remaining}, so'ralgan: ${requested})`,
        ru: `Принимаемое количество превышает остаток по заказу (осталось: ${remaining}, запрошено: ${requested})`,
        en: `Received quantity exceeds the remaining ordered quantity (remaining: ${remaining}, requested: ${requested})`,
      },
      { purchaseOrderLineId, remaining, requested },
    );
  }
}

export class ReceiptWarehouseMismatchException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'GOODS_RECEIPT_WAREHOUSE_MISMATCH', {
      uz: 'Qabul ombori xarid buyurtmasidagi ombor bilan bir xil bo\'lishi kerak',
      ru: 'Склад приёмки должен совпадать со складом заказа поставщику',
      en: 'The receipt warehouse must match the purchase order warehouse',
    });
  }
}

export class ReceiptSupplierMismatchException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'GOODS_RECEIPT_SUPPLIER_MISMATCH', {
      uz: "Yetkazib beruvchi xarid buyurtmasidagi yetkazib beruvchi bilan bir xil bo'lishi kerak",
      ru: 'Поставщик должен совпадать с поставщиком заказа',
      en: 'The supplier must match the purchase order supplier',
    });
  }
}

export class ReceiptWarehouseRequiredException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'GOODS_RECEIPT_WAREHOUSE_REQUIRED', {
      uz: "Xarid buyurtmasisiz qabulda ombor ko'rsatilishi shart",
      ru: 'Для приёмки без заказа поставщику нужно указать склад',
      en: 'A warehouse is required for a receipt without a purchase order',
    });
  }
}

export class InvalidReceiptLineException extends AppException {
  constructor(reason: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'GOODS_RECEIPT_INVALID_LINE',
      {
        uz: "Qabul qatori noto'g'ri: xarid buyurtmasi qatori yoki mahsulot mos emas",
        ru: 'Некорректная строка приёмки: строка заказа или товар не совпадают',
        en: 'Invalid receipt line: purchase order line or product does not match',
      },
      { reason },
    );
  }
}
