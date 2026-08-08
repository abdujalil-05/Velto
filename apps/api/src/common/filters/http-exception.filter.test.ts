import { describe, expect, it, vi } from 'vitest';
import { HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter';

function mockHost() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
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
});
