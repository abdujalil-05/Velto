import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException, HttpStatus, Logger, type ArgumentsHost } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { AllExceptionsFilter } from './http-exception.filter';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

function mockHost() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

/** Silences Nest's console output and lets the level (warn vs error) be asserted. */
function spyOnLogger() {
  return {
    warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  };
}

describe('AllExceptionsFilter', () => {
  it('passes an AppException-shaped body through unchanged (7.1 error contract)', () => {
    const filter = new AllExceptionsFilter();
    const { host, status, json } = mockHost();
    const exception = new HttpException(
      { code: 'CUSTOMER_BLOCKED', message: { uz: 'a', ru: 'b', en: 'c' }, details: { customerId: '1' } },
      HttpStatus.CONFLICT,
    );

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith({
      code: 'CUSTOMER_BLOCKED',
      message: { uz: 'a', ru: 'b', en: 'c' },
      details: { customerId: '1' },
    });
  });

  it('normalizes a generic NestJS HttpException to the trilingual envelope', () => {
    const filter = new AllExceptionsFilter();
    const { host, status, json } = mockHost();

    filter.catch(new HttpException('Forbidden', HttpStatus.FORBIDDEN), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'HTTP_403',
        message: expect.objectContaining({
          uz: expect.any(String),
          ru: expect.any(String),
          en: expect.any(String),
        }),
      }),
    );
  });

  it('keeps class-validator field errors as details', () => {
    const filter = new AllExceptionsFilter();
    const { host, json } = mockHost();

    filter.catch(
      new HttpException({ statusCode: 400, message: ['phone must be a valid phone number'], error: 'Bad Request' }, HttpStatus.BAD_REQUEST),
      host,
    );

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ details: ['phone must be a valid phone number'] }),
    );
  });

  it('never leaks a stack trace for unexpected errors (SEC-045)', () => {
    const filter = new AllExceptionsFilter();
    const { host, status, json } = mockHost();

    filter.catch(new Error('boom, secret internals'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = json.mock.calls[0]![0];
    expect(JSON.stringify(body)).not.toContain('boom');
    expect(body.code).toBe('HTTP_500');
  });

  // SQLSTATE 22003 (numeric field overflow) is bad client input, not a server
  // fault: it must answer 400 NUMERIC_OUT_OF_RANGE, be logged as a warning, and
  // stay out of Sentry. Prisma surfaces it either as P2020 or as a raw driver
  // error carrying the SQLSTATE in its message, so both paths are covered.
  describe('numeric overflow (SQLSTATE 22003)', () => {
    let logger: ReturnType<typeof spyOnLogger>;

    beforeEach(() => {
      vi.mocked(Sentry.captureException).mockClear();
      logger = spyOnLogger();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('maps a Prisma P2020 error to 400 NUMERIC_OUT_OF_RANGE with all three locales', () => {
      const filter = new AllExceptionsFilter();
      const { host, status, json } = mockHost();
      const prismaError = Object.assign(new Error('Value out of range for the type.'), {
        code: 'P2020',
        clientVersion: '5.0.0',
      });

      filter.catch(prismaError, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      const body = json.mock.calls[0]![0];
      expect(body.code).toBe('NUMERIC_OUT_OF_RANGE');
      for (const locale of ['uz', 'ru', 'en'] as const) {
        expect(typeof body.message[locale]).toBe('string');
        expect(body.message[locale].length).toBeGreaterThan(0);
      }
    });

    it('maps a raw driver error carrying SQLSTATE 22003 (no P2020 code) to 400', () => {
      const filter = new AllExceptionsFilter();
      const { host, status, json } = mockHost();
      const rawDriverError = new Error(
        'Raw query failed. Code: `22003`. Message: `numeric field overflow`',
      );

      filter.catch(rawDriverError, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(json.mock.calls[0]![0].code).toBe('NUMERIC_OUT_OF_RANGE');
    });

    it('logs the overflow as a warning, not an error, and does not report it to Sentry', () => {
      const filter = new AllExceptionsFilter();
      const { host } = mockHost();

      filter.catch(Object.assign(new Error('Value out of range for the type.'), { code: 'P2020' }), host);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    // Regression: matching a bare `22003` substring classified unrelated
    // failures as client input — 400 + warn + no Sentry — so genuine 500s
    // silently vanished from monitoring whenever the digits happened to occur
    // in a UUID, a document number or an amount.
    it('does not treat an incidental "22003" in a UUID or amount as an overflow', () => {
      const filter = new AllExceptionsFilter();
      const { host, status, json } = mockHost();
      const unrelated = new Error(
        'Failed to write invoice 3f22003a-9c1e-4b77-8a2d-0f1e2d3c4b5a (total 122003.50): connection terminated unexpectedly',
      );

      filter.catch(unrelated, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json.mock.calls[0]![0].code).toBe('HTTP_500');
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });

    it('does not treat a plain object carrying code "P2020" as a Prisma error', () => {
      const filter = new AllExceptionsFilter();
      const { host, status, json } = mockHost();

      filter.catch({ code: 'P2020', message: 'attacker-controlled payload echo' }, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json.mock.calls[0]![0].code).toBe('HTTP_500');
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });

    it('does not swallow other database errors — a non-22003 SQLSTATE still yields 500', () => {
      const filter = new AllExceptionsFilter();
      const { host, status, json } = mockHost();
      const uniqueViolation = Object.assign(
        new Error('Unique constraint failed. Code: `23505`. Message: `duplicate key value violates unique constraint`'),
        { code: 'P2002' },
      );

      filter.catch(uniqueViolation, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json.mock.calls[0]![0].code).toBe('HTTP_500');
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });
  });
});
