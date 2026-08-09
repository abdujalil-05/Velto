import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // Behind nginx on the same host: trust only the loopback hop for
  // X-Forwarded-For/-Proto so req.ip resolves to the real client IP (used by
  // ThrottlerGuard's per-IP bucketing and AuditLog's recorded IP — SEC-045).
  // 'loopback' (not `true`/a wildcard) deliberately excludes trusting every
  // hop, so a client can't spoof X-Forwarded-For to evade the rate limiter.
  if (config.get<boolean>('TRUST_PROXY', false)) {
    app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
  }

  // 11.7 "xato tracker ulandi" — no-op (SDK calls are safe pre-init) until
  // SENTRY_DSN is set in the deploy environment; dev/CI never set it.
  const sentryDsn = config.get<string>('SENTRY_DSN', '');
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, environment: config.get<string>('NODE_ENV', 'development') });
  }

  // SEC-040..048: CSP/HSTS/X-Frame-Options headers, and CORS restricted to
  // the known web/miniapp origins instead of reflecting every request.
  configureApp(
    app,
    config.getOrThrow<string>('CORS_ORIGINS').split(',').map((origin) => origin.trim()),
  );

  const port = process.env.API_PORT ?? 3001;
  const host = process.env.API_HOST ?? '0.0.0.0';
  await app.listen(port, host);
  Logger.log(`Velto API listening on ${host}:${port}`, 'Bootstrap');
}

bootstrap();
