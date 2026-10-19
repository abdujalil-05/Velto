import { IsUUID } from 'class-validator';

/** ADR-029: GET /payments/in-transit — "yo'lda" (PENDING_HANDOVER) total for one customer. */
export class PaymentInTransitQueryDto {
  @IsUUID()
  customerId!: string;
}
