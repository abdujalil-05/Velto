import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Prisma } from '@velto/database';
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

const NUMERIC_OUT_OF_RANGE_MESSAGE: LocalizedMessage = {
  uz: "Kiritilgan son juda katta — qiymatni kichraytiring",
  ru: 'Введённое число слишком велико — уменьшите значение',
  en: 'The entered number is too large — reduce the value',
};

/**
 * A value that overflows its column (money `numeric(18,2)`, quantity
 * `numeric(18,3)`, or an `integer` column such as `Customer.paymentTermDays`)
 * is bad *input*, not a server fault, so it must answer 400 rather than 500.
 *
 * Per-field `@Max` bounds (common/validators/numeric-bounds.ts) reject the
 * obvious cases up front, but a value can also overflow only after the service
 * multiplies it (sales: qty x qtyInBaseUnit x unitPrice) — no DTO rule can
 * catch that without rejecting legitimate input, so this is the backstop.
 *
 * Postgres reports every one of these as SQLSTATE 22003. Prisma surfaces it
 * either as a known-request error `P2020` or, for a raw driver error, as an
 * unknown-request error whose message carries the SQLSTATE/text — hence the
 * match on both.
 *
 * The match must stay *narrow*: anything wrongly classified here is answered
 * 400, logged as a warning and deliberately kept out of Sentry, so a real 500
 * would disappear from monitoring. A bare `message.includes('22003')` is not
 * safe — `22003` occurs inside UUIDs, document numbers and amounts (`122003`).
 */

/** SQLSTATE as it actually reaches us: Prisma's raw-query wrapper, or driver text. */
const SQLSTATE_22003_PATTERNS = [
  /Code:\s*`22003`/, // Prisma: "Raw query failed. Code: `22003`. Message: `...`"
  /\bSQLSTATE[:= ]\s*'?22003'?/i, // node-postgres / libpq text form
];

/** Postgres' own wording for the same condition, when no SQLSTATE is carried. */
const NUMERIC_OVERFLOW_TEXT_PATTERNS = [
  /numeric field overflow/i,
  /out of range for type/i,
  /value overflows numeric format/i,
];

/**
 * Prisma re-exports its error classes per generated client, so `instanceof`
 * can miss an error thrown by a differently-resolved copy of the client (and
 * by test fixtures that reproduce the shape). Accept either, but require a
 * real `Error` carrying a Prisma-formatted `Pxxxx` code — not any bag with a
 * `code` property.
 */
function isPrismaKnownRequestError(exception: object): boolean {
  if (exception instanceof Prisma.PrismaClientKnownRequestError) return true;
  const code = (exception as { code?: unknown }).code;
  return exception instanceof Error && typeof code === 'string' && /^P\d{4}$/.test(code);
}

/** Structured SQLSTATE, if the error carries one (driver `code`, or Prisma `meta.code`). */
function sqlState(exception: object): string | undefined {
  const meta = (exception as { meta?: unknown }).meta;
  const metaCode = meta && typeof meta === 'object' ? (meta as { code?: unknown }).code : undefined;
  if (typeof metaCode === 'string') return metaCode;

  const code = (exception as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

function isNumericOutOfRange(exception: unknown): boolean {
  if (!exception || typeof exception !== 'object') return false;

  // Structured signals first — they are unambiguous.
  if (isPrismaKnownRequestError(exception) && (exception as { code?: unknown }).code === 'P2020') return true;
  if (sqlState(exception) === '22003') return true;

  // Message text only as a fallback, and only in the shapes the SQLSTATE
  // genuinely arrives in (never a bare `22003` substring).
  const message = (exception as { message?: unknown }).message;
  if (typeof message !== 'string') return false;

  return (
    SQLSTATE_22003_PATTERNS.some((pattern) => pattern.test(message)) ||
    NUMERIC_OVERFLOW_TEXT_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/** Enough context to identify the overflowing column when triaging an incident. */
function describeOverflow(exception: unknown): string {
  if (!exception || typeof exception !== 'object') return String(exception);
  const code = (exception as { code?: unknown }).code;
  const message = (exception as { message?: unknown }).message;
  const parts = [
    typeof code === 'string' ? `code=${code}` : undefined,
    typeof message === 'string' ? message.slice(0, 500) : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : String(exception);
}

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

    // Checked before the generic 500 path so it is neither reported to Sentry
    // nor logged as an error — it is a routine client-input rejection.
    if (isNumericOutOfRange(exception)) {
      this.logger.warn(`Rejected out-of-range numeric input (SQLSTATE 22003): ${describeOverflow(exception)}`);
      response.status(HttpStatus.BAD_REQUEST).json({
        code: 'NUMERIC_OUT_OF_RANGE',
        message: NUMERIC_OUT_OF_RANGE_MESSAGE,
      } satisfies ApiErrorBody);
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
