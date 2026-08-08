import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { SessionExpiredException } from '../../common/auth/auth-exceptions';
import { AuthService, parseDurationMs, type RequestMeta, type TelegramWebhookUpdate, type TokenPair } from './auth.service';
import { ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { TelegramAuthDto } from './dto/telegram-auth.dto';
import { PasswordResetService } from './password-reset.service';

function requestMeta(req: Request): RequestMeta {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

// Scoped to /auth (not the whole API) so it's only ever sent back on the
// refresh/logout calls that need it. apps/web is the only consumer: it never
// stores the refresh token itself and relies entirely on this cookie. Telegram
// Mini App users go through /auth/telegram instead, which never sets this
// cookie — the app is iframed inside web.telegram.org (see
// apps/miniapp/next.config.mjs's frame-ancestors), a cross-site embedding
// where third-party cookie blocking would make a cookie-only flow unreliable.
// It keeps using its existing body/localStorage refresh token untouched.
const REFRESH_COOKIE_NAME = 'velto_refresh_token';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly passwordResetService: PasswordResetService,
  ) {}

  private setRefreshCookie(res: Response, refreshToken: string): void {
    const refreshTtlMs = parseDurationMs(this.configService.get<string>('JWT_REFRESH_TTL', '30d'));
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: this.configService.get<string>('NODE_ENV', 'development') === 'production',
      sameSite: 'lax',
      path: '/auth',
      maxAge: refreshTtlMs,
    });
  }

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto, requestMeta(req));
    this.setRefreshCookie(res, result.refreshToken);
    return this.withoutRefreshToken(result);
  }

  @Public()
  @Post('telegram')
  telegram(@Body() dto: TelegramAuthDto, @Req() req: Request) {
    return this.authService.telegramLogin(dto, requestMeta(req));
  }

  // Registered with Telegram via `setWebhook`'s secret_token param — every
  // call must carry that same secret back in this header, or it isn't
  // actually Telegram calling. Always 200s (Telegram retries non-2xx
  // responses); linkTelegramContact() never throws.
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
    await this.authService.linkTelegramContact(update);
    return { ok: true };
  }

  @Public()
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
      this.setRefreshCookie(res, result.refreshToken);
      return this.withoutRefreshToken(result);
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
  async confirmPasswordReset(@Body() dto: ConfirmPasswordResetDto) {
    await this.passwordResetService.confirm(dto.phone, dto.code, dto.newPassword);
  }

  // Public: identity for this endpoint is the refresh token (cookie or body),
  // not the (possibly already-expired) access token — a user must be able to
  // log out even when their session has technically expired.
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
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

  private withoutRefreshToken(result: TokenPair): Omit<TokenPair, 'refreshToken'> {
    return { accessToken: result.accessToken, user: result.user };
  }
}
