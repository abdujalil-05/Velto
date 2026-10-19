import { HttpException, HttpStatus } from '@nestjs/common';
import { AppException } from '../errors/app-exception';

export class ServiceUnavailableAppException extends AppException {
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', {
      uz: "Xizmat vaqtincha mavjud emas. Birozdan keyin qayta urinib ko'ring",
      ru: 'Сервис временно недоступен. Повторите попытку позже',
      en: 'Service temporarily unavailable. Please try again shortly',
    });
  }
}

/** ADR-050 fail-closed: an infrastructure (Redis) error becomes 503 SERVICE_UNAVAILABLE; domain HttpExceptions pass through. */
export async function failClosedOnRedis<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpException) throw err;
    throw new ServiceUnavailableAppException();
  }
}
