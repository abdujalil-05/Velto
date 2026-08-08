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
 * 9.4-follow-up: a visit can no longer be logged from outside the outlet's
 * 150m radius, full stop — no reason-based bypass. Reports the actual
 * distance so the agent knows how far off they are.
 */
export class GpsTooFarException extends AppException {
  constructor(distanceMeters: number) {
    const rounded = Math.round(distanceMeters);
    super(
      HttpStatus.CONFLICT,
      'VISIT_GPS_TOO_FAR',
      {
        uz: `Siz nuqtadan ${rounded}m uzoqdasiz (ruxsat etilgan: 150m) — yaqinlashib qayta urinib ko'ring`,
        ru: `Вы в ${rounded}м от точки (допустимо: 150м) — подойдите ближе и повторите`,
        en: `You're ${rounded}m from the outlet (allowed: 150m) — get closer and try again`,
      },
      { distanceMeters: rounded },
    );
  }
}

/**
 * Marshrut kunning oxirida "tugatish" uchun har bir bekatda GPS-tasdiqlangan
 * tashrif bo'lishi kerak (9.4-follow-up). Missing outlet names are surfaced
 * so the agent knows exactly which stops are still open.
 */
export class RouteNotReadyException extends AppException {
  constructor(missingOutletNames: string[]) {
    const list = missingOutletNames.join(', ');
    super(
      HttpStatus.CONFLICT,
      'ROUTE_NOT_READY',
      {
        uz: `Marshrutni tugatib bo'lmaydi — quyidagi nuqtalarda hali tasdiqlangan tashrif yo'q: ${list}`,
        ru: `Невозможно завершить маршрут — нет подтверждённого визита по точкам: ${list}`,
        en: `Can't finish the route — these stops don't have a GPS-verified visit yet: ${list}`,
      },
      { missingOutletNames },
    );
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
