import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class RouteNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'ROUTE_NOT_FOUND', {
      uz: 'Marshrut topilmadi',
      ru: 'Маршрут не найден',
      en: 'Route not found',
    });
  }
}

export class VisitNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'VISIT_NOT_FOUND', {
      uz: 'Tashrif topilmadi',
      ru: 'Визит не найден',
      en: 'Visit not found',
    });
  }
}

export class AgentNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'FIELD_AGENT_NOT_FOUND', {
      uz: 'Agent topilmadi',
      ru: 'Агент не найден',
      en: 'Agent not found',
    });
  }
}

/**
 * Marshrut kunning oxirida "tugatish" uchun har bir bekatda GPS-tasdiqlangan
 * tashrif bo'lishi kerak (9.4-follow-up). Missing outlet names are surfaced
 * so the agent knows exactly which stops are still open.
 */
export interface OpenRouteStop {
  outletId: string;
  outletName: string;
  /** NO_VISIT, or the latest visit's GpsStatus (OUTSIDE_RADIUS, LOW_ACCURACY, NO_PERMISSION, NO_FIX). */
  reason: string;
}

export class RouteNotReadyException extends AppException {
  constructor(openStops: OpenRouteStop[]) {
    const list = openStops.map((s) => s.outletName).join(', ');
    super(
      HttpStatus.CONFLICT,
      'ROUTE_NOT_READY',
      {
        uz: `Marshrutni tugatib bo'lmaydi — quyidagi nuqtalar yopilmagan (GPS-tasdiqlangan tashrif yoki sabab bilan o'tkazib yuborish kerak): ${list}`,
        ru: `Невозможно завершить маршрут — не закрыты точки (нужен подтверждённый визит или пропуск с причиной): ${list}`,
        en: `Can't finish the route — these stops are still open (need a GPS-verified visit or a skip with a reason): ${list}`,
      },
      { openStops, missingOutletNames: openStops.map((s) => s.outletName) },
    );
  }
}

/** ADR-003a: courier routes are delivery runs, not agent visit rounds — no "finish" for them. */
export class CourierRouteFinishForbiddenException extends AppException {
  constructor() {
    super(HttpStatus.FORBIDDEN, 'ROUTE_COURIER_FINISH_FORBIDDEN', {
      uz: "Kuryer marshrutini tugatib bo'lmaydi — yetkazib berish buyurtmalar orqali yakunlanadi",
      ru: 'Маршрут курьера нельзя завершить — доставка закрывается по заказам',
      en: 'A courier route cannot be finished — deliveries are completed per order',
    });
  }
}

/** SEC-023: an agent may only act on their own route. */
export class RouteNotOwnedException extends AppException {
  constructor() {
    super(HttpStatus.FORBIDDEN, 'ROUTE_NOT_OWNED', {
      uz: "Siz faqat o'zingizning marshrutingiz bilan ishlay olasiz",
      ru: 'Вы можете работать только со своим маршрутом',
      en: 'You can only act on your own route',
    });
  }
}

export class RouteStopNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'ROUTE_STOP_NOT_FOUND', {
      uz: 'Bu nuqta marshrutda yo\'q',
      ru: 'Этой точки нет в маршруте',
      en: 'This stop is not part of the route',
    });
  }
}

export class RouteStopAlreadyClosedException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'ROUTE_STOP_ALREADY_CLOSED', {
      uz: "Bu nuqta bugun allaqachon yopilgan",
      ru: 'Эта точка уже закрыта сегодня',
      en: 'This stop is already closed today',
    });
  }
}

export class RouteNotScheduledTodayException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'ROUTE_NOT_SCHEDULED_TODAY', {
      uz: 'Bu marshrut bugungi kunga rejalashtirilmagan',
      ru: 'Этот маршрут не запланирован на сегодня',
      en: "This route isn't scheduled for today",
    });
  }
}

export class VisitSkipReasonRequiredException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'VISIT_SKIP_REASON_REQUIRED', {
      uz: "O'tkazib yuborilgan tashrif uchun sabab ko'rsatilishi shart",
      ru: 'Для пропущенного визита необходимо указать причину',
      en: 'A skip reason is required for a skipped visit',
    });
  }
}

export class VisitStartedAtInFutureException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'VISIT_STARTED_AT_IN_FUTURE', {
      uz: "Tashrif boshlanish vaqti kelajakda (qurilma soatini tekshiring)",
      ru: 'Время начала визита в будущем (проверьте часы устройства)',
      en: 'Visit start time is in the future (check the device clock)',
    });
  }
}

export class VisitStartedAtTooOldException extends AppException {
  constructor(maxAgeDays: number) {
    super(
      HttpStatus.BAD_REQUEST,
      'VISIT_STARTED_AT_TOO_OLD',
      {
        uz: `Tashrif boshlanish vaqti ${maxAgeDays} kundan eski`,
        ru: `Время начала визита старше ${maxAgeDays} дн.`,
        en: `Visit start time is older than ${maxAgeDays} days`,
      },
      { maxAgeDays },
    );
  }
}
