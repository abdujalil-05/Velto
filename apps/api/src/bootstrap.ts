import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';

/**
 * Shared between main.ts and the e2e test harness (test/e2e/setup.ts) so an
 * e2e run exercises the exact same guards/pipes/filters production traffic
 * does — helmet headers, CORS, DTO whitelist validation, and the stack-trace-
 * free exception filter (SEC-040..048) — instead of a hand-rolled subset
 * that could silently drift from what main.ts actually configures.
 */
export function configureApp(app: INestApplication, corsOrigins: string[]): void {
  app.use(helmet());
  app.use(cookieParser());
  // credentials: true is required alongside an explicit origin allowlist
  // (never '*') for the httpOnly refresh-token cookie (see auth.controller.ts)
  // to be sent/accepted cross-origin between the web/miniapp origins and this API.
  app.enableCors({ origin: corsOrigins, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
}
