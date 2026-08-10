import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { OrderStatus } from '@velto/database';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

export class ListOrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  agentId?: string;

  // Kuryer filter, mirroring `agentId` above — the courier is an own User
  // (COURIER role) the order's delivery was handed to.
  @IsOptional()
  @IsUUID()
  courierId?: string;

  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  // Optional — when provided, scopes results to createdAt in [from, to]
  // (inclusive, end-of-day per report-utils' resolveDateRange). Omitted by
  // every existing caller (unbounded list); the Telegram Mini App's agent
  // home screen (9.4) uses this to scope today's order count/turnover.
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
