import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { PaymentMethod } from '@velto/database';
import { IsMoneyAmount } from '../../../common/validators/numeric-bounds';

/** 8.4 manual-override line: explicit invoice/amount pairs instead of FIFO. */
export class PaymentAllocationInputDto {
  @IsUUID()
  invoiceId!: string;

  @IsMoneyAmount()
  amount!: number;
}

/** 9.2 "/payments ... yangi to'lov formasi (taqsimlash UI bilan)". */
export class CreatePaymentDto {
  @IsUUID()
  customerId!: string;

  @IsMoneyAmount()
  amount!: number;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  // Offline idempotency key (10.3) — maps 1:1 to Payment.clientId.
  @IsOptional()
  @IsUUID()
  clientId?: string;

  // Omitted => 8.4 automatic FIFO across the customer's oldest open invoices.
  // Provided => manual allocation, capped to `amount` and each invoice's outstanding balance.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentAllocationInputDto)
  allocations?: PaymentAllocationInputDto[];
}
