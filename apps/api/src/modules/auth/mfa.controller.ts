import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AllowDuringMaintenance } from '../../common/maintenance/allow-during-maintenance.decorator';
import { TenantTx } from '../../common/tenant/tenant-tx-options.decorator';
import { MfaChallengeDto, MfaEnrollConfirmDto, MfaReenrollDto, MfaVerifyDto, RegenerateRecoveryCodesDto } from './dto/mfa.dto';
import { MfaService } from './mfa.service';
import { requestMeta, setRefreshCookie, withoutRefreshToken } from './session-http';

@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @AllowDuringMaintenance()
  @HttpCode(HttpStatus.OK)
  @Post('enroll/start')
  enrollStart(@Body() dto: MfaChallengeDto, @Req() req: Request) {
    return this.mfa.startEnroll(dto.mfaChallenge, requestMeta(req));
  }

  @Public()
  @AllowDuringMaintenance()
  @HttpCode(HttpStatus.OK)
  @Post('enroll/confirm')
  async enrollConfirm(@Body() dto: MfaEnrollConfirmDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.mfa.confirmEnroll(dto, requestMeta(req));
    setRefreshCookie(res, this.config, session.refreshToken);
    return withoutRefreshToken(session);
  }

  @Public()
  @AllowDuringMaintenance()
  @HttpCode(HttpStatus.OK)
  @Post('verify')
  async verify(@Body() dto: MfaVerifyDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.mfa.verify(dto, requestMeta(req));
    setRefreshCookie(res, this.config, session.refreshToken);
    return withoutRefreshToken(session);
  }

  // Authenticated self-service for the caller's own MFA — no module permission (like GET /auth/me);
  // handler scope: the service opens its own short transactions so failed attempts are audited.
  @TenantTx({ scope: 'handler' })
  @HttpCode(HttpStatus.OK)
  @Post('reenroll')
  reenroll(@Body() dto: MfaReenrollDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.mfa.startReenroll(user, dto, requestMeta(req));
  }

  @TenantTx({ scope: 'handler' })
  @HttpCode(HttpStatus.OK)
  @Post('recovery-codes/regenerate')
  regenerateRecoveryCodes(@Body() dto: RegenerateRecoveryCodesDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.mfa.regenerateRecoveryCodes(user, dto, requestMeta(req));
  }
}
