import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaymentSource, PaymentStatus } from '@velto/database';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

export class ListPaymentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  // The Telegram Mini App's agent home screen (9.4, "Yig'ilgan: ...") scopes
  // to payments *it* collected, not by customer.
  @IsOptional()
  @IsUUID()
  collectedBy?: string;

  // Optional — scopes results to the posting date coalesce(handoverAt,
  // createdAt) in [from, to] (inclusive, end-of-day; ADR-029, same rule as
  // 1C export). Omitted by every existing caller; the Telegram Mini App's
  // agent home screen (9.4) uses this for today's collected total.
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  // ADR-029: e.g. PENDING_HANDOVER for the cashier's "to accept" queue.
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  // F6: COLLECTION = money received, OPENING = carried-over opening credit.
  // Omitted + a from/to period => COLLECTION only ("yig'ilgan" in a period
  // never includes opening balances); omitted without a period => both.
  @IsOptional()
  @IsEnum(PaymentSource)
  source?: PaymentSource;
}
