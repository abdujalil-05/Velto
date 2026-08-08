import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export type SortDir = 'asc' | 'desc';

/** 7.1: "Ro'yxat endpoint'larida pagination majburiy (default 25, max 100)." */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 25;

  // 9.1 "har ro'yxatda ... saralash" — the column to sort by. Never used as a
  // raw Prisma field name: each service resolves it through resolveSort()
  // below against its own allow-list, so an unknown/malicious value just
  // falls back to that endpoint's default order instead of erroring or
  // reaching Prisma directly.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: SortDir;
}

/**
 * Resolves a client-requested `sortBy`/`sortDir` into a Prisma `orderBy`,
 * via a per-endpoint allow-list of column-name -> orderBy-builder — the
 * client can only ever select among columns the service explicitly listed,
 * never an arbitrary Prisma field path. Falls back to `fallback` when
 * `sortBy` is omitted or not in the allow-list.
 */
export function resolveSort<TOrderBy>(
  query: { sortBy?: string; sortDir?: SortDir },
  allowlist: Record<string, (dir: SortDir) => TOrderBy>,
  fallback: TOrderBy,
): TOrderBy {
  // `Object.hasOwn` (not a bare index) — otherwise `?sortBy=constructor`
  // resolves off the prototype chain and blows up Prisma's orderBy.
  const builder =
    query.sortBy && Object.hasOwn(allowlist, query.sortBy) ? allowlist[query.sortBy] : undefined;
  return builder ? builder(query.sortDir ?? 'asc') : fallback;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}

export function paginate<T>(data: T[], total: number, page: number, pageSize: number): PaginatedResult<T> {
  return { data, meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}
