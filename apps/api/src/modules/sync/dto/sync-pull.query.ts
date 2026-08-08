import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

/** 7.3 "GET /sync/pull?since=<cursor>". */
export class SyncPullQueryDto {
  @IsOptional()
  @IsISO8601()
  since?: string;

  // Only meaningful for a non-agent caller (e.g. a supervisor pulling a
  // specific agent's routes) — a SALES_AGENT always pulls their own.
  @IsOptional()
  @IsUUID()
  agentId?: string;
}
