import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class SalesOrderNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'SALES_ORDER_NOT_FOUND', {
      uz: 'Buyurtma topilmadi',
      ru: 'Заказ не найден',
      en: 'Order not found',
    });
  }
}

export class EmptyOrderException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'SALES_ORDER_EMPTY', {
      uz: "Buyurtmada kamida bitta qator bo'lishi kerak",
      ru: 'В заказе должна быть хотя бы одна строка',
      en: 'An order must have at least one line',
    });
  }
}

export class InvalidOrderTransitionException extends AppException {
  constructor(from: string, to: string) {
    super(
      HttpStatus.CONFLICT,
      'SALES_ORDER_INVALID_TRANSITION',
      {
        uz: `Buyurtmani "${from}" holatidan "${to}"ga o'tkazib bo'lmaydi`,
        ru: `Невозможно перевести заказ из "${from}" в "${to}"`,
        en: `Cannot move an order from "${from}" to "${to}"`,
      },
      { from, to },
    );
  }
}

export class PriceNotFoundException extends AppException {
  constructor(productId: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'SALES_PRICE_NOT_FOUND',
      {
        uz: 'Ushbu mahsulot uchun narx topilmadi',
        ru: 'Цена для этого товара не найдена',
        en: 'No price found for this product',
      },
      { productId },
    );
  }
}

export class PackagingMismatchException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'SALES_PACKAGING_MISMATCH', {
      uz: 'Qadoq ushbu mahsulotga tegishli emas',
      ru: 'Упаковка не относится к этому товару',
      en: 'That packaging does not belong to this product',
    });
  }
}

export class AmbiguousWarehouseException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'SALES_AMBIGUOUS_WAREHOUSE', {
      uz: "Kompaniyada bir nechta ombor bor — warehouseId ko'rsating",
      ru: 'В компании несколько складов — укажите warehouseId',
      en: 'This company has more than one warehouse — specify warehouseId',
    });
  }
}

/**
 * A courier is an ordinary `User` carrying the fixed system role `COURIER`
 * (rbac-catalog.ts), so "not found" here covers all three ways the id can be
 * wrong: no such user in this tenant, deactivated, or an active user who
 * simply isn't a courier. Deliberately one message for all three — the caller
 * picks from `GET /users?roleCode=COURIER`, so anything else is a bad request,
 * not a state the UI needs to distinguish.
 */
export class CourierNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'COURIER_NOT_FOUND', {
      uz: 'Kuryer topilmadi yoki faol emas',
      ru: 'Курьер не найден или неактивен',
      en: 'Courier not found or inactive',
    });
  }
}

/**
 * A courier may only close out the deliveries actually handed to them.
 * Deliberately a 403 rather than the "not found" an agent gets for someone
 * else's order: the courier is looking at a real order (they may have just
 * been un-assigned from it), so hiding its existence would only be confusing.
 */
export class OrderNotAssignedToCourierException extends AppException {
  constructor() {
    super(HttpStatus.FORBIDDEN, 'SALES_ORDER_NOT_ASSIGNED_TO_COURIER', {
      uz: 'Bu buyurtma sizga biriktirilmagan',
      ru: 'Этот заказ не закреплён за вами',
      en: 'This order is not assigned to you',
    });
  }
}

/** F2.4: deliveredQty is negative, malformed or has more than 3 decimals. */
export class InvalidDeliveredQtyException extends AppException {
  constructor(lineId: string, deliveredQty: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'SALES_INVALID_DELIVERED_QTY',
      {
        uz: "Yetkazilgan miqdor noto'g'ri (manfiy bo'lmagan, ko'pi bilan 3 kasr xonali son bo'lishi kerak)",
        ru: 'Некорректное отгруженное количество (неотрицательное число, не более 3 знаков после запятой)',
        en: 'Invalid delivered quantity (must be non-negative, at most 3 decimal places)',
      },
      { lineId, deliveredQty },
    );
  }
}

/** F2.4: deliveredQty > ordered qty — the DB CHECK is only the backstop. */
export class OverDeliveryException extends AppException {
  constructor(lineId: string, qty: string, deliveredQty: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'SALES_OVER_DELIVERY',
      {
        uz: 'Yetkazilgan miqdor buyurtma qilingan miqdordan oshib ketdi',
        ru: 'Отгруженное количество превышает заказанное',
        en: 'Delivered quantity exceeds the ordered quantity',
      },
      { lineId, qty, deliveredQty },
    );
  }
}

/** F2.4: `lines` must list every order line exactly once — no unknown, duplicate or missing ids. */
export class DeliveryLinesMismatchException extends AppException {
  constructor(details: { unknown: string[]; duplicate: string[]; missing: string[] }) {
    super(
      HttpStatus.BAD_REQUEST,
      'SALES_DELIVERY_LINES_MISMATCH',
      {
        uz: "Yetkazish qatorlari buyurtma qatorlariga mos emas (har bir qator aynan bir marta ko'rsatilishi kerak)",
        ru: 'Строки отгрузки не совпадают со строками заказа (каждая строка должна быть указана ровно один раз)',
        en: 'Delivery lines do not match the order lines (every line must be listed exactly once)',
      },
      details,
    );
  }
}

/** F2.4: a delivery where nothing at all is delivered — that is a cancel, not a delivery. */
export class EmptyDeliveryException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'SALES_EMPTY_DELIVERY', {
      uz: "Kamida bitta qatorda yetkazilgan miqdor 0 dan katta bo'lishi kerak",
      ru: 'Хотя бы в одной строке отгруженное количество должно быть больше 0',
      en: 'At least one line must have a delivered quantity greater than 0',
    });
  }
}

/** F2.4: partial delivery is a warehouse/director/owner action; the courier Mini App path is full delivery only. */
export class PartialDeliveryNotAllowedException extends AppException {
  constructor() {
    super(HttpStatus.FORBIDDEN, 'SALES_PARTIAL_DELIVERY_NOT_ALLOWED', {
      uz: 'Qisman yetkazishni faqat ombor yoki rahbar qayd eta oladi',
      ru: 'Частичную отгрузку может оформить только склад или руководитель',
      en: 'Only warehouse or management can record a partial delivery',
    });
  }
}

export class CustomerBlockedException extends AppException {
  constructor(reason?: string | null) {
    super(HttpStatus.CONFLICT, 'SALES_CUSTOMER_BLOCKED', {
      uz: `Mijoz bloklangan${reason ? ` (${reason})` : ''} — buyurtma yaratib bo'lmaydi`,
      ru: `Клиент заблокирован${reason ? ` (${reason})` : ''} — нельзя создать заказ`,
      en: `Customer is blocked${reason ? ` (${reason})` : ''} — cannot create an order`,
    });
  }
}
