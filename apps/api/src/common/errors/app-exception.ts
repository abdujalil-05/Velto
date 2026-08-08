import { HttpException, HttpStatus } from '@nestjs/common';

/** Trilingual message per VELTO-TZ.md 9.1/14.6 — o'zbek (lotin), rus, ingliz. */
export interface LocalizedMessage {
  uz: string;
  ru: string;
  en: string;
}

export interface ApiErrorBody {
  code: string;
  message: LocalizedMessage;
  details?: unknown;
}

/**
 * Every domain error thrown by a service/controller should be an
 * AppException (or a plain NestJS HttpException, which the global filter
 * falls back to translating generically) so the response body always
 * matches the contract in 7.1: `{ code, message, details }`.
 */
export class AppException extends HttpException {
  constructor(status: HttpStatus, code: string, message: LocalizedMessage, details?: unknown) {
    super({ code, message, details } satisfies ApiErrorBody, status);
  }
}
