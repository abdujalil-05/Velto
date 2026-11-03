import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../../../../common/auth/auth.types';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../../common/decorators/require-permission.decorator';
import {
  ConfirmPaymentReconciliationDto,
  ListPaymentReconciliationsQueryDto,
  PaymentReconciliationStatusDto,
} from '../../dto/payment-reconciliation.dto';
import { PaymentReconciliationService } from './payment-reconciliation.service';

/**
 * PO 2026-11-02: reconciliation of rejected offline payment intents. Must be
 * registered BEFORE PaymentsController so `GET /payments/reconciliations` is
 * not captured by `GET /payments/:id`.
 */
@Controller('payments/reconciliations')
export class PaymentReconciliationController {
  constructor(private readonly reconciliation: PaymentReconciliationService) {}

  // OWNER + CASHIER only (`payments.handover`); 201 on a new decision, 200 on an identical replay.
  @Post()
  @RequirePermission('payments.handover')
  async confirm(
    @Body() dto: ConfirmPaymentReconciliationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reconciliation.confirm(dto, user);
    res.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  @Get()
  @RequirePermission('payments.read')
  list(@Query() query: ListPaymentReconciliationsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reconciliation.list(query, user);
  }

  // Agent-facing (Mini App contract): own rejected intents only, others UNKNOWN.
  @Post('status')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payments.create')
  status(@Body() dto: PaymentReconciliationStatusDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reconciliation.status(dto, user);
  }
}
