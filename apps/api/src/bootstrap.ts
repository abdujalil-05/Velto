import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import './common/serialization/bigint-json';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { traceMiddleware } from './common/trace/trace.middleware';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { assertJsonSourceSupport, jsonNumberGuardErrorHandler, jsonNumberGuardReviver } from './common/serialization/json-number-guard';

/**
 * Shared between main.ts and the e2e test harness (test/e2e/setup.ts) so an
 * e2e run exercises the exact same guards/pipes/filters production traffic
 * does — helmet headers, CORS, DTO whitelist validation, and the stack-trace-
 * free exception filter (SEC-040..048) — instead of a hand-rolled subset
 * that could silently drift from what main.ts actually configures.
 */
export function configureApp(app: INestApplication, corsOrigins: string[]): void {
  // Must precede Nest's default json parser (skipped once a 'jsonParser' is registered). ADR-059.
  assertJsonSourceSupport();
  app.use(traceMiddleware);
  (app as NestExpressApplication).useBodyParser('json', { reviver: jsonNumberGuardReviver });
  app.use(jsonNumberGuardErrorHandler);
  app.use(helmet());
  app.use(cookieParser());
  // credentials: true is required alongside an explicit origin allowlist
  // (never '*') for the httpOnly refresh-token cookie (see auth.controller.ts)
  // to be sent/accepted cross-origin between the web/miniapp origins and this API.
  // exposedHeaders: the web UI must read the download's SHA-256 and filename cross-origin (ADR-030).
  app.enableCors({ origin: corsOrigins, credentials: true, exposedHeaders: ['X-Content-SHA256', 'Content-Disposition', 'Retry-After'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
}
