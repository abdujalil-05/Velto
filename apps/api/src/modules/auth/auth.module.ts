import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { SmsModule } from '../../common/sms/sms.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimiterService } from './login-rate-limiter.service';
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
  controllers: [AuthController],
  providers: [AuthService, LoginRateLimiterService, AuditLogService, PasswordResetService],
  // Re-exported so AppModule's global JwtAuthGuard (APP_GUARD) can inject JwtService.
  exports: [JwtModule],
})
export class AuthModule {}
