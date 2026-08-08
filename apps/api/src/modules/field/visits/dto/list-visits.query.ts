import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination.dto';

export class ListVisitsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsOptional()
  @IsUUID()
  outletId?: string;

  // Optional — scopes results to startedAt in [from, to] (inclusive,
  // end-of-day). Omitted by every existing caller; the Telegram Mini App's
  // agent home screen (9.4) uses this for today's visited/total stop count.
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
