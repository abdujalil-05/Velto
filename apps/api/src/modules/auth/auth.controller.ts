import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { SessionExpiredException } from '../../common/auth/auth-exceptions';
import { AuthService, type TelegramWebhookUpdate } from './auth.service';
import { Throttle } from '@nestjs/throttler';
import { TenantTx } from '../../common/tenant/tenant-tx-options.decorator';
import { OfflineKekQueryDto } from './dto/offline-kek-query.dto';
import { ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { SelectCompanyDto } from './dto/select-company.dto';
import { SelectResetAccountDto } from './dto/select-reset-account.dto';
import { TelegramAuthDto } from './dto/telegram-auth.dto';
import { OfflineKekService, type OfflineKek } from './offline-kek.service';
import { PasswordResetService } from './password-reset.service';
import { REFRESH_COOKIE_NAME, requestMeta, setRefreshCookie, withoutRefreshToken } from './session-http';
import { AllowDuringMaintenance } from '../../common/maintenance/allow-during-maintenance.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly passwordResetService: PasswordResetService,
    private readonly offlineKekService: OfflineKekService,
  ) {}

  @Public()
  @AllowDuringMaintenance()
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto, requestMeta(req));
    if ('requiresCompanySelection' in result || 'mfa' in result) return result;
    setRefreshCookie(res, this.configService, result.refreshToken);
    return withoutRefreshToken(result);
  }

  // ADR-057: second step when a correct password matched several companies.
  @Public()
  @AllowDuringMaintenance()
  @HttpCode(HttpStatus.OK)
  @Post('login/select-company')
  async selectCompany(@Body() dto: SelectCompanyDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.selectCompany(dto, requestMeta(req));
    if ('mfa' in result) return result;
    setRefreshCookie(res, this.configService, result.refreshToken);
    return withoutRefreshToken(result);
  }

  @Public()
  @AllowDuringMaintenance()
  @Post('telegram')
  telegram(@Body() dto: TelegramAuthDto, @Req() req: Request) {
    return this.authService.telegramLogin(dto, requestMeta(req));
  }

  // Registered with Telegram via `setWebhook`'s secret_token param — every
  // call must carry that same secret back in this header, or it isn't
  // actually Telegram calling. Always 200s (Telegram retries non-2xx
  // responses); handleTelegramUpdate() never throws. Carries the contact-share
  // linking flow for every Telegram-logging-in User (agents and couriers).
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('telegram/webhook')
  async telegramWebhook(
    @Body() update: TelegramWebhookUpdate,
    @Headers('x-telegram-bot-api-secret-token') secretHeader: string | undefined,
  ) {
    const expected = this.configService.get<string>('TELEGRAM_WEBHOOK_SECRET', '');
    if (!expected || secretHeader !== expected) {
      throw new ForbiddenException();
    }
    await this.authService.handleTelegramUpdate(update);
    return { ok: true };
  }

  @Public()
  @AllowDuringMaintenance()
  @Post('refresh')
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tokenFromCookie = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    const refreshToken = tokenFromCookie ?? dto.refreshToken;
    if (!refreshToken) {
      throw new SessionExpiredException();
    }

    const result = await this.authService.refresh({ refreshToken }, requestMeta(req));

    // Only re-issue the cookie (and hide the raw token from the JSON body)
    // for callers that authenticated via the cookie in the first place — a
    // request that came in with dto.refreshToken instead (apps/miniapp)
    // still gets the body-based shape it has always relied on.
    if (tokenFromCookie) {
      setRefreshCookie(res, this.configService, result.refreshToken);
      return withoutRefreshToken(result);
    }
    return result;
  }

  // "Parolni unutdingizmi?" — sends a 6-digit SMS code. Always 204 regardless
  // of whether the phone matches an account (SEC: no user enumeration);
  // PasswordResetService itself rate-limits per phone.
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('password-reset/request')
  async requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    await this.passwordResetService.request(dto.phone);
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('password-reset/confirm')
  async confirmPasswordReset(@Body() dto: ConfirmPasswordResetDto, @Res({ passthrough: true }) res: Response) {
    // 204 when the phone has exactly one account (password changed); 200 + body when
    // several accounts need a choice (nothing changed yet — see password-reset/select-account).
    const result = await this.passwordResetService.confirm(dto.phone, dto.code, dto.newPassword);
    if (result) {
      res.status(HttpStatus.OK);
      return result;
    }
  }

  // ADR-057a: after OTP proof, the client picks one account via the single-use handle.
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('password-reset/select-account')
  async selectResetAccount(@Body() dto: SelectResetAccountDto, @Req() req: Request) {
    await this.passwordResetService.selectAccount(dto, requestMeta(req).ip);
  }

  // Public: identity for this endpoint is the refresh token (cookie or body),
  // not the (possibly already-expired) access token — a user must be able to
  // log out even when their session has technically expired.
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @AllowDuringMaintenance()
  @Post('logout')
  async logout(@Body() dto: LogoutDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tokenFromCookie = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    const refreshToken = tokenFromCookie ?? dto.refreshToken;
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
    if (refreshToken) {
      await this.authService.logout({ refreshToken, allDevices: dto.allDevices });
    }
  }

  // Not @Public — exercises the full JwtAuthGuard -> TenantContextInterceptor
  // pipeline (fresh DB-loaded roles/permissions, never trusting the JWT
  // payload alone). The web app calls this once after login to bootstrap
  // the session (who am I, what can I do).
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  // Identity comes only from the authenticated user (never query/body). Any active authenticated user;
  // the interceptor already re-read the user from DB (RLS-bound company membership). Handler scope: no open
  // request tx, so denial audits persist. Cache headers are set by NoStoreMiddleware (also covers errors).
  @Get('offline-kek')
  @TenantTx({ scope: 'handler' })
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  offlineKek(@CurrentUser() user: AuthenticatedUser, @Query() query: OfflineKekQueryDto, @Req() req: Request): Promise<OfflineKek> {
    return this.offlineKekService.issue(user, query.version, requestMeta(req).ip);
  }
}
