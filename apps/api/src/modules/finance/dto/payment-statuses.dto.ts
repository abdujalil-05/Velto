import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from 'class-validator';

export const PAYMENT_STATUSES_MAX = 100;

/**
 * ADR-029: body of POST /payments/statuses — the Mini App asks for the
 * cashier's decision on its own queued payments by server id and/or offline
 * clientId (1..100 in total, checked in the service).
 */
export class PaymentStatusesDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PAYMENT_STATUSES_MAX)
  @IsUUID('all', { each: true })
  ids?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PAYMENT_STATUSES_MAX)
  @IsUUID('all', { each: true })
  clientIds?: string[];
}
