import { IsDateString, IsOptional, IsUUID } from 'class-validator';
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

  // Optional — scopes results to createdAt in [from, to] (inclusive,
  // end-of-day). Omitted by every existing caller; the Telegram Mini App's
  // agent home screen (9.4) uses this for today's collected total.
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
