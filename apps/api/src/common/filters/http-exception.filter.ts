import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { Response } from 'express';
import type { ApiErrorBody, LocalizedMessage } from '../errors/app-exception';

const GENERIC_MESSAGES: Record<number, LocalizedMessage> = {
  [HttpStatus.BAD_REQUEST]: { uz: "So'rov noto'g'ri", ru: 'Некорректный запрос', en: 'Bad request' },
  [HttpStatus.UNAUTHORIZED]: { uz: 'Tizimga kirish talab qilinadi', ru: 'Требуется авторизация', en: 'Authentication required' },
  [HttpStatus.FORBIDDEN]: { uz: 'Ruxsat berilmagan', ru: 'Доступ запрещён', en: 'Forbidden' },
  [HttpStatus.NOT_FOUND]: { uz: 'Topilmadi', ru: 'Не найдено', en: 'Not found' },
  [HttpStatus.CONFLICT]: { uz: "Ziddiyat yuz berdi", ru: 'Конфликт данных', en: 'Conflict' },
  [HttpStatus.UNPROCESSABLE_ENTITY]: { uz: "Ma'lumot noto'g'ri", ru: 'Некорректные данные', en: 'Unprocessable entity' },
  [HttpStatus.TOO_MANY_REQUESTS]: { uz: "So'rovlar soni oshib ketdi", ru: 'Слишком много запросов', en: 'Too many requests' },
  [HttpStatus.INTERNAL_SERVER_ERROR]: { uz: 'Server xatoligi', ru: 'Ошибка сервера', en: 'Internal server error' },
};

/**
 * Normalizes every error response to `{ code, message, details }` (7.1),
 * with `message` always in uz/ru/en (9.1/14.6). Never leaks a stack trace
 * (SEC-045) — unexpected errors are logged server-side and returned as a
 * generic 500 body.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json(this.normalize(status, body));
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : exception);
    // No-op if SENTRY_DSN wasn't set at bootstrap (main.ts) — only truly
    // unexpected errors are reported, not routine 4xx HttpExceptions above.
    Sentry.captureException(exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(this.normalize(HttpStatus.INTERNAL_SERVER_ERROR, null));
  }

  private normalize(status: number, body: unknown): ApiErrorBody {
    if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
      return body as ApiErrorBody;
    }

    // NestJS default HttpException shape ({ statusCode, message, error }) or
    // a plain string — fall back to a generic localized message, keeping any
    // validation detail (e.g. class-validator's message array) as `details`.
    const details =
      body && typeof body === 'object' && 'message' in body
        ? (body as { message: unknown }).message
        : typeof body === 'string'
          ? body
          : undefined;

    return {
      code: `HTTP_${status}`,
      message: GENERIC_MESSAGES[status] ?? GENERIC_MESSAGES[HttpStatus.INTERNAL_SERVER_ERROR]!,
      details,
    };
  }
}
