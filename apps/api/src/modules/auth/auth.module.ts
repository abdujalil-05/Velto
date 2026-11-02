import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { SecretBox } from '../../common/crypto/secret-box';
import { SmsModule } from '../../common/sms/sms.module';
import { AuthChallengeStore } from './auth-challenge.store';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimiterService } from './login-rate-limiter.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { OfflineKekService } from './offline-kek.service';
import { PasswordResetService } from './password-reset.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_ACCESS_TTL', '15m') },
      }),
    }),
    SmsModule,
  ],
  controllers: [AuthController, MfaController],
  providers: [AuthService, AuthChallengeStore, LoginRateLimiterService, AuditLogService, PasswordResetService, SecretBox, MfaService, OfflineKekService],
  // Re-exported so AppModule's global JwtAuthGuard (APP_GUARD) can inject JwtService.
  exports: [JwtModule, MfaService, AuthChallengeStore],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Key material responses (and their errors) must never be cached.
    consumer
      .apply((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        next();
      })
      .forRoutes('auth/offline-kek');
  }
}
