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
 * picks from `GET /orders/assignable-couriers`. 404, like any foreign/unknown
 * id: another tenant's user is indistinguishable from a nonexistent one.
 */
export class CourierNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'COURIER_NOT_FOUND', {
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

/**
 * P0: a courierId on create sends the order straight to SHIPPED and reserves
 * stock — confirm()'s effect (`orders.update`) plus the courier hand-over
 * (`orders.assignCourier`); both are required. Holding only `orders.create` (SALES_AGENT, also via
 * /sync/push) must not bypass director approval.
 */
export class CourierAssignmentForbiddenException extends AppException {
  constructor() {
    super(HttpStatus.FORBIDDEN, 'SALES_ORDER_COURIER_ASSIGN_FORBIDDEN', {
      uz: "Buyurtmaga kuryer biriktirish uchun ruxsat yo'q",
      ru: 'Нет прав на назначение курьера заказу',
      en: 'You are not allowed to assign a courier to an order',
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

/** One order line whose client-confirmed price no longer matches the server price (F4 offline sync). */
export interface PriceChangedLine {
  lineIndex: number;
  productId: string;
  packagingId: string;
  expectedUnitPrice: string;
  serverUnitPrice: string;
}

/**
 * F4: an offline-created order line carried an `expectedUnitPrice` that no
 * longer equals the server-resolved price. The order is never silently
 * repriced — nothing is written and the agent re-confirms on the device.
 */
export class PriceChangedException extends AppException {
  constructor(details: { lines: PriceChangedLine[]; expectedTotal: string; serverTotal: string }) {
    super(
      HttpStatus.CONFLICT,
      'PRICE_CHANGED',
      {
        uz: "Narx o'zgargan — buyurtmani yangi narx bilan qayta tasdiqlang",
        ru: 'Цена изменилась — подтвердите заказ по новой цене',
        en: 'Price has changed — re-confirm the order at the new price',
      },
      details,
    );
  }
}

/**
 * ADR-059a: an entered qty or its base-unit conversion (qty × packaging
 * qtyInBaseUnit) has more than 3 decimal places. SalesOrderLine.qty is
 * Decimal(18,3); the quantity is rejected, never silently rounded.
 */
export class OrderQtyPrecisionException extends AppException {
  constructor(details: { productId: string; packagingId: string; qty: string; qtyInBaseUnit: string; baseQty: string; maxDecimals: number }) {
    super(
      HttpStatus.BAD_REQUEST,
      'ORDER_QTY_PRECISION',
      {
        uz: `Miqdor asosiy birlikda ko'pi bilan 3 kasr xonali bo'lishi kerak (kiritildi ${details.qty} × ${details.qtyInBaseUnit} = ${details.baseQty})`,
        ru: `Количество в базовой единице должно иметь не более 3 знаков после запятой (введено ${details.qty} × ${details.qtyInBaseUnit} = ${details.baseQty})`,
        en: `Quantity in the base unit may have at most 3 decimal places (entered ${details.qty} × ${details.qtyInBaseUnit} = ${details.baseQty})`,
      },
      details,
    );
  }
}

/**
 * ADR-059b: effective unit price (unitPrice × (1 − discount/100), ex-VAT,
 * base unit, unrounded) is below the product's minPrice. No role bypass.
 */
export class OrderPriceBelowMinException extends AppException {
  constructor(details: { productId: string; effectivePrice: string; minPrice: string }) {
    super(
      HttpStatus.BAD_REQUEST,
      'ORDER_PRICE_BELOW_MIN',
      {
        uz: `Sotuv narxi (${details.effectivePrice}) mahsulotning minimal narxidan (${details.minPrice}) past`,
        ru: `Цена продажи (${details.effectivePrice}) ниже минимальной цены товара (${details.minPrice})`,
        en: `Sale price (${details.effectivePrice}) is below the product's minimum price (${details.minPrice})`,
      },
      details,
    );
  }
}

/**
 * Defence in depth for the partial unique index "Invoice_sale_orderId_key"
 * (one SALE invoice per order, migration 20261102100000). deliver() holds the
 * order row FOR UPDATE and checks for an existing SALE invoice before any
 * write, so this fires with no stock movement written.
 */
export class OrderAlreadyInvoicedException extends AppException {
  constructor(orderId: string) {
    super(
      HttpStatus.CONFLICT,
      'ORDER_ALREADY_INVOICED',
      {
        uz: 'Bu buyurtma uchun ichki hisob allaqachon yaratilgan',
        ru: 'Для этого заказа внутренний счёт уже создан',
        en: 'An internal invoice has already been created for this order',
      },
      { orderId },
    );
  }
}

/** ADR-069/070: a courier is assigned (or re-assigned) only on a CONFIRMED order. */
export class CourierAssignInvalidStatusException extends AppException {
  constructor(status: string) {
    super(
      HttpStatus.CONFLICT,
      'SALES_ORDER_COURIER_ASSIGN_INVALID_STATUS',
      {
        uz: `Kuryer faqat tasdiqlangan (CONFIRMED) buyurtmaga biriktiriladi; joriy holat: "${status}"`,
        ru: `Курьера можно назначить только подтверждённому (CONFIRMED) заказу; текущий статус: "${status}"`,
        en: `A courier can only be assigned to a CONFIRMED order; current status: "${status}"`,
      },
      { status },
    );
  }
}

/** PO decision C: only a SHIPPED order can come back from the courier to the warehouse. */
export class ReturnToWarehouseInvalidStatusException extends AppException {
  constructor(status: string) {
    super(
      HttpStatus.CONFLICT,
      'SALES_ORDER_RETURN_INVALID_STATUS',
      {
        uz: `Faqat yo'ldagi (SHIPPED) buyurtmani omborga qaytarish mumkin; joriy holat: "${status}"`,
        ru: `Вернуть на склад можно только отгруженный (SHIPPED) заказ; текущий статус: "${status}"`,
        en: `Only a SHIPPED order can be returned to the warehouse; current status: "${status}"`,
      },
      { status },
    );
  }
}

/** PO decision D: a SHIPPED order is with the courier — return it to the warehouse before cancelling. */
export class OrderShippedRequiresReturnException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'SALES_ORDER_SHIPPED_REQUIRES_RETURN', {
      uz: "Buyurtma kuryerda (SHIPPED). Bekor qilishdan oldin uni omborga qaytaring",
      ru: 'Заказ у курьера (SHIPPED). Перед отменой верните его на склад',
      en: 'The order is with the courier (SHIPPED). Return it to the warehouse before cancelling',
    });
  }
}

/** ADR-069/070: the goods are already with the courier (SHIPPED) — return to the warehouse before re-assigning. */
export class OrderAlreadyHandedOverException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'SALES_ORDER_ALREADY_HANDED_OVER', {
      uz: "Buyurtma allaqachon kuryerga topshirilgan (SHIPPED). Kuryerni almashtirishdan oldin uni omborga qaytaring",
      ru: 'Заказ уже передан курьеру (SHIPPED). Перед сменой курьера верните его на склад',
      en: 'The order is already handed over to the courier (SHIPPED). Return it to the warehouse first',
    });
  }
}

/** ADR-069/070: handover is CONFIRMED → SHIPPED only (SHIPPED = idempotent no-op). */
export class HandoverInvalidStatusException extends AppException {
  constructor(status: string) {
    super(
      HttpStatus.CONFLICT,
      'SALES_ORDER_HANDOVER_INVALID_STATUS',
      {
        uz: `Kuryerga faqat tasdiqlangan (CONFIRMED) buyurtma topshiriladi; joriy holat: "${status}"`,
        ru: `Передать курьеру можно только подтверждённый (CONFIRMED) заказ; текущий статус: "${status}"`,
        en: `Only a CONFIRMED order can be handed over to a courier; current status: "${status}"`,
      },
      { status },
    );
  }
}

/** ADR-069/070: handover needs an assigned courier. */
export class HandoverCourierRequiredException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'SALES_ORDER_HANDOVER_NO_COURIER', {
      uz: 'Topshirishdan oldin buyurtmaga kuryer biriktiring',
      ru: 'Перед передачей назначьте заказу курьера',
      en: 'Assign a courier to the order before handing it over',
    });
  }
}

/** ADR-069/070: handover body named a courier other than the one assigned (stale screen / concurrent reassign). */
export class HandoverCourierMismatchException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'SALES_ORDER_HANDOVER_COURIER_MISMATCH', {
      uz: "Buyurtmaga boshqa kuryer biriktirilgan. Sahifani yangilang",
      ru: 'Заказу назначен другой курьер. Обновите страницу',
      en: 'A different courier is assigned to this order. Refresh and try again',
    });
  }
}

/** ADR-069/070: a CONFIRMED order with a courier must be handed over (→ SHIPPED) before delivery. */
export class OrderHandoverRequiredException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'SALES_ORDER_HANDOVER_REQUIRED', {
      uz: "Buyurtmaga kuryer biriktirilgan, lekin hali topshirilmagan. Avval kuryerga topshiring",
      ru: 'Заказу назначен курьер, но он ещё не передан. Сначала передайте заказ курьеру',
      en: 'A courier is assigned but the order has not been handed over yet. Hand it over first',
    });
  }
}
