import { HttpStatus } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { getTraceId } from '../trace/trace-context';
import { Prisma } from '@velto/database';
import { ApiErrorBody, AppException } from '../errors/app-exception';

/**
 * ADR-059: body-parser's JSON.parse turns every JSON number into a double, so a
 * literal such as 99999999999999.99 silently becomes 99999999999999.98 before any
 * DTO sees it. Node >= 21 hands the reviver the original source text; a number
 * whose exact decimal value differs from what the double holds is rejected (400),
 * never altered.
 */
const MARKER = 'JSON_NUMBER_PRECISION_LOSS:';

export class JsonNumberPrecisionLossException extends AppException {
  constructor(path: string, value: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'JSON_NUMBER_PRECISION_LOSS',
      {
        uz: "JSON sonini aniq ifodalab bo'lmaydi (aniqlik yo'qoladi). Sonni qisqaroq yuboring.",
        ru: 'Число в JSON нельзя представить точно (потеря точности). Отправьте число короче.',
        en: 'JSON number cannot be represented exactly (precision loss). Send a shorter number.',
      },
      { path, value: value.slice(0, 40) },
    );
  }
}

const SAFE_INTEGER_SOURCE = /^-?\d{1,15}$/;

type ReviverContext = { source?: string } | undefined;

export function jsonNumberGuardReviver(this: unknown, key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value !== 'number') return value;
  const source = context?.source;
  if (typeof source !== 'string') throw new Error('JSON.parse reviver source text unavailable (Node >= 21 required)');
  if (SAFE_INTEGER_SOURCE.test(source)) return value;
  let exact: boolean;
  try {
    exact = new Prisma.Decimal(source).equals(new Prisma.Decimal(String(value)));
  } catch {
    exact = false; // Infinity / NaN from overflow such as 1e999
  }
  // body-parser re-wraps thrown errors keeping only `message`, so the details travel in it.
  if (!exact) throw new SyntaxError(MARKER + JSON.stringify({ path: key, value: source.slice(0, 40) }));
  return value;
}

/** Fail-closed boot check: refuse to start where the reviver gets no source text. */
export function assertJsonSourceSupport(): void {
  let seen: unknown;
  const probe = (_k: string, v: unknown, ctx?: ReviverContext) => {
    seen = ctx?.source;
    return v;
  };
  JSON.parse('1.5', probe as (this: unknown, key: string, value: unknown) => unknown); // lib.d.ts lacks the context arg
  if (seen !== '1.5') throw new Error('JSON.parse source-text access unavailable: Node >= 21 required (ADR-059)');
}

/**
 * Error middleware registered right after the parser: turns the marker error back
 * into the `{ code, message, details }` contract (body-parser discards the original class).
 */
export function jsonNumberGuardErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const message = err instanceof Error ? err.message : '';
  if (!message.startsWith(MARKER)) return next(err);
  const d = JSON.parse(message.slice(MARKER.length)) as { path: string; value: string };
  const exception = new JsonNumberPrecisionLossException(d.path, d.value);
  const traceId = getTraceId();
  res.status(HttpStatus.BAD_REQUEST).json({ ...(exception.getResponse() as object), ...(traceId ? { traceId } : {}) });
}
