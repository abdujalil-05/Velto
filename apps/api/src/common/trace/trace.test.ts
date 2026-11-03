import { Controller, Get, Module, type INestApplication, BadRequestException, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppException } from '../errors/app-exception';
import { AllExceptionsFilter } from '../filters/http-exception.filter';
import { getTraceId } from './trace-context';
import { TraceLogger } from './trace-logger';
import { traceMiddleware } from './trace.middleware';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

@Controller('t')
class TestController {
  @Get('ok') ok() {
    return { traceId: getTraceId() };
  }
  @Get('app') app() {
    throw new AppException(HttpStatus.CONFLICT, 'X', { uz: 'a', ru: 'b', en: 'c' });
  }
  @Get('val') val() {
    throw new BadRequestException(['field must be a string']);
  }
  @Get('boom') boom() {
    throw new Error('boom');
  }
}
@Module({ controllers: [TestController] })
class TestModule {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request trace id', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mod = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = mod.createNestApplication();
    app.use(traceMiddleware);
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(() => app.close());

  it('generates a UUID, exposes it in header and context', async () => {
    const res = await request(app.getHttpServer()).get('/t/ok').expect(200);
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.body.traceId).toBe(res.headers['x-request-id']);
  });

  it('propagates a valid incoming id', async () => {
    const res = await request(app.getHttpServer()).get('/t/ok').set('X-Request-Id', 'abc-12345_XYZ');
    expect(res.headers['x-request-id']).toBe('abc-12345_XYZ');
    expect(res.body.traceId).toBe('abc-12345_XYZ');
  });

  it.each(['short', 'has space in it!!', 'a'.repeat(65), 'evil<script>1234'])('replaces unsafe incoming id %s', async (bad) => {
    const res = await request(app.getHttpServer()).get('/t/ok').set('X-Request-Id', bad);
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it.each([
    ['app', 409, 'X'],
    ['val', 400, 'HTTP_400'],
    ['boom', 500, 'HTTP_500'],
  ])('error body of /%s carries traceId', async (path, status, code) => {
    const res = await request(app.getHttpServer()).get(`/t/${path}`).set('X-Request-Id', 'trace-id-1234');
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(res.body.traceId).toBe('trace-id-1234');
    expect(res.headers['x-request-id']).toBe('trace-id-1234');
  });
});

describe('TraceLogger', () => {
  it('tags lines emitted inside a request with the trace id', async () => {
    const lines: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
    const logger = new TraceLogger();
    await new Promise<void>((resolve) =>
      traceMiddleware({ headers: { 'x-request-id': 'log-trace-1234' } } as never, { setHeader: () => undefined } as never, () => {
        logger.log('hello', 'Ctx');
        resolve();
      }),
    );
    stdoutSpy.mockRestore();
    expect(lines.join('')).toContain('[trace=log-trace-1234]');
  });
});
