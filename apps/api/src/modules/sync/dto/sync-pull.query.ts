import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const SYNC_PULL_DEFAULT_LIMIT = 500;
export const SYNC_PULL_MAX_LIMIT = 1000;

/** 7.3 "GET /sync/pull?cursor=<opaque>&limit=<n>". Absent cursor = full snapshot (first call). */
export class SyncPullQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  // Backward-compatible alias for `cursor` (the pre-F4 name). A legacy ISO
  // timestamp is not a valid cursor and simply triggers a full resync.
  @IsOptional()
  @IsString()
  @MaxLength(512)
  since?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SYNC_PULL_MAX_LIMIT)
  limit?: number;

  // Only meaningful for a non-agent caller (e.g. a supervisor pulling a
  // specific agent's routes) — a SALES_AGENT always pulls their own.
  @IsOptional()
  @IsUUID()
  agentId?: string;
}
