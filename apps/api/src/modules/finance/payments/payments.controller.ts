import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { ReverseReasonDto } from '../../../common/dto/reverse-reason.dto';
import { Idempotent } from '../../../common/idempotency/idempotent.decorator';
import { AllocatePaymentDto } from '../dto/allocate-payment.dto';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { ListPaymentsQueryDto } from '../dto/list-payments.query';
import { PaymentInTransitQueryDto } from '../dto/payment-in-transit.query';
import { PaymentStatusesDto } from '../dto/payment-statuses.dto';
import { RejectPaymentHandoverDto } from '../dto/reject-payment-handover.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @RequirePermission('payments.read')
  list(@Query() query: ListPaymentsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.list(query, user);
  }

  // ADR-029 "yo'lda": declared before ':id' so the literal path wins.
  @Get('in-transit')
  @RequirePermission('payments.read')
  inTransit(@Query() query: PaymentInTransitQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.inTransitSummary(query.customerId, user);
  }

  // ADR-029: read-only batch status lookup (POST only because of the id list
  // size); declared before ':id' routes. SALES_AGENT sees own payments only.
  @Post('statuses')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payments.read')
  statuses(@Body() dto: PaymentStatusesDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.statuses(dto, user);
  }

  @Get(':id')
  @RequirePermission('payments.read')
  getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.getById(id, user);
  }

  @Post()
  @RequirePermission('payments.create')
  create(@Body() dto: CreatePaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.create(dto, user);
  }

  // F2.1: later manual allocation of a payment's advance. Dedicated grant
  // (OWNER, SALES_DIRECTOR, CASHIER) — never SALES_AGENT or ACCOUNTANT.
  @Post(':id/allocate')
  @Idempotent()
  @RequirePermission('payments.allocate')
  allocate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AllocatePaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.allocate(id, dto, user);
  }

  // ADR-029: cashier handover of agent cash (OWNER, SALES_DIRECTOR, CASHIER).
  @Post(':id/handover/accept')
  @Idempotent()
  @RequirePermission('payments.handover')
  acceptHandover(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.acceptHandover(id, user);
  }

  @Post(':id/handover/reject')
  @Idempotent()
  @RequirePermission('payments.handover')
  rejectHandover(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectPaymentHandoverDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.rejectHandover(id, dto.reason, user);
  }

  @Post(':id/reverse')
  @Idempotent()
  @RequirePermission('payments.reverse')
  reverse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReverseReasonDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.reverse(id, dto.reason, user);
  }
}
