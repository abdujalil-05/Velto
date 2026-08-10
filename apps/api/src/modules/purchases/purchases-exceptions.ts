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

export class PurchaseOrderNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'PURCHASE_ORDER_NOT_FOUND', {
      uz: 'Xarid buyurtmasi topilmadi',
      ru: 'Заказ на закупку не найден',
      en: 'Purchase order not found',
    });
  }
}

export class EmptyPurchaseOrderException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'PURCHASE_ORDER_EMPTY', {
      uz: "Xarid buyurtmasida kamida bitta qator bo'lishi kerak",
      ru: 'Заказ на закупку должен содержать хотя бы одну строку',
      en: 'A purchase order must have at least one line',
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
        ru: `Невозможно перевести заказ на закупку из "${from}" в "${to}"`,
        en: `Cannot move a purchase order from "${from}" to "${to}"`,
      },
      { from, to },
    );
  }
}

export class EmptyReceiptException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'PURCHASE_ORDER_EMPTY_RECEIPT', {
      uz: "Qabul qilishda kamida bitta qator bo'lishi kerak",
      ru: 'Приёмка должна содержать хотя бы одну строку',
      en: 'A receipt must have at least one line',
    });
  }
}

export class OverReceiptException extends AppException {
  constructor(remaining: string, requested: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'PURCHASE_ORDER_OVER_RECEIPT',
      {
        uz: `Buyurtma qilingandan ortiq qabul qilib bo'lmaydi (qolgan: ${remaining}, so'ralgan: ${requested})`,
        ru: `Нельзя принять больше заказанного (осталось: ${remaining}, запрошено: ${requested})`,
        en: `Cannot receive more than was ordered (remaining: ${remaining}, requested: ${requested})`,
      },
      { remaining, requested },
    );
  }
}

export class SupplierRouteNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'SUPPLIER_ROUTE_NOT_FOUND', {
      uz: 'Yetkazib beruvchi marshruti topilmadi',
      ru: 'Маршрут поставщика не найден',
      en: 'Supplier route not found',
    });
  }
}

/**
 * A supplier already has an active SupplierTelegramLink. Issuing a second
 * link code would be a silent account takeover of the existing one (schema:
 * `@@unique([supplierId])` means the redemption would overwrite it), so the
 * caller must DELETE /suppliers/:id/telegram first.
 */
export class SupplierTelegramAlreadyLinkedException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'SUPPLIER_TELEGRAM_ALREADY_LINKED', {
      uz: "Yetkazib beruvchi allaqachon Telegramga bog'langan. Avval bog'lanishni uzing",
      ru: 'Поставщик уже привязан к Telegram. Сначала отвяжите текущую привязку',
      en: 'Supplier is already linked to Telegram. Unlink the current account first',
    });
  }
}

export class SupplierTelegramNotLinkedException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'SUPPLIER_TELEGRAM_NOT_LINKED', {
      uz: "Yetkazib beruvchi Telegramga bog'lanmagan",
      ru: 'Поставщик не привязан к Telegram',
      en: 'Supplier is not linked to Telegram',
    });
  }
}

export class PurchaseOrderLineNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'PURCHASE_ORDER_LINE_NOT_FOUND', {
      uz: 'Xarid buyurtmasi qatori topilmadi',
      ru: 'Строка заказа на закупку не найдена',
      en: 'Purchase order line not found',
    });
  }
}
