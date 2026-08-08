import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './common/config/env.schema';
import { AuditLogService } from './common/audit/audit-log.service';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { TenantContextInterceptor } from './common/auth/tenant-context.interceptor';
import { QueueModule } from './common/queue/queue.module';
import { RedisModule } from './common/redis/redis.module';
import { TenantModule } from './common/tenant/tenant.module';
import { HealthModule } from './health/health.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CustomersModule } from './modules/customers/customers.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { ImportModule } from './modules/import/import.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { StockModule } from './modules/stock/stock.module';
import { SalesModule } from './modules/sales/sales.module';
import { FinanceModule } from './modules/finance/finance.module';
import { FieldModule } from './modules/field/field.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SyncModule } from './modules/sync/sync.module';
import { PurchasesModule } from './modules/purchases/purchases.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // Turbo/pnpm run this package's scripts with cwd=apps/api, so the
      // monorepo root .env (shared by every app) isn't found by default;
      // a local apps/api/.env, if present, still overrides it.
      envFilePath: ['../../.env', '.env'],
    }),
    // SEC-045: general request rate limiting (IP-scoped), on top of the
    // phone-scoped LoginRateLimiterService for the login endpoint specifically.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    RedisModule,
    QueueModule,
    TenantModule,
    AuthModule,
    CatalogModule,
    CustomersModule,
    NotificationsModule,
    StockModule,
    SalesModule,
    FinanceModule,
    FieldModule,
    SyncModule,
    PurchasesModule,
    UsersModule,
    AnalyticsModule,
    AuditModule,
    SettingsModule,
    IntegrationsModule,
    ImportModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    AuditLogService,
  ],
})
export class AppModule {}
