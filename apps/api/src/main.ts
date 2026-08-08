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
  await app.listen(port);
  Logger.log(`Velto API listening on :${port}`, 'Bootstrap');
}

bootstrap();
