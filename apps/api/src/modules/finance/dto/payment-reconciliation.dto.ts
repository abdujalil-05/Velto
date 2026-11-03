import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaymentReconciliationOutcome } from '@velto/database';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const RECONCILIATION_STATUS_MAX = 100;
export const RECONCILIATION_CLIENT_ID_MAX = 128;

/** PO 2026-11-02: POST /payments/reconciliations — cashier/owner decision on a rejected offline payment intent. */
export class ConfirmPaymentReconciliationDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(RECONCILIATION_CLIENT_ID_MAX)
  clientId!: string;

  @IsEnum(PaymentReconciliationOutcome)
  outcome!: PaymentReconciliationOutcome;

  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

  // Required for NOT_POSTED_CONFIRMED (checked in the service -> trilingual 400).
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  evidenceRef?: string;
}

export class ListPaymentReconciliationsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['OPEN', 'RESOLVED'])
  status: 'OPEN' | 'RESOLVED' = 'OPEN';
}

/** POST /payments/reconciliations/status — Mini App asks about its own rejected intents (contract fixed). */
export class PaymentReconciliationStatusDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(RECONCILIATION_STATUS_MAX)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(RECONCILIATION_CLIENT_ID_MAX, { each: true })
  clientIds!: string[];
}
