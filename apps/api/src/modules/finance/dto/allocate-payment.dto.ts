import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, IsUUID, Matches, ValidateNested } from 'class-validator';

/**
 * Decimal(18,2) money as a string, strictly > 0, < 10^15 (MAX_MONEY): no
 * float round-trip, no exponent, no sign, at most 2 fraction digits.
 */
export const POSITIVE_MONEY_STRING = /^(?!0+(?:\.0{1,2})?$)\d{1,15}(?:\.\d{1,2})?$/;

export class AllocatePaymentLineDto {
  @IsUUID()
  invoiceId!: string;

  @IsString()
  @Matches(POSITIVE_MONEY_STRING, { message: 'amount must be a positive decimal string with at most 2 fraction digits' })
  amount!: string;
}

/** F2.1: POST /payments/:id/allocate — manually apply an existing payment's advance. */
export class AllocatePaymentDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AllocatePaymentLineDto)
  allocations!: AllocatePaymentLineDto[];
}
