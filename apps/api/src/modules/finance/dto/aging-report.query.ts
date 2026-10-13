import { IsISO8601, IsOptional, Matches } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

/** Report-date-only filter shared by the screen and the export (TZ §6.5: "as-of" sana aniq belgilanadi). */
export class AgingAsOfQueryDto {
  // Calendar date (YYYY-MM-DD) interpreted as an Asia/Tashkent day; omitted = today in Asia/Tashkent.
  // IsISO8601 strict rejects impossible dates (2026-02-30) that the regex alone would let through.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  asOf?: string;
}

/** 9.2 "/receivables ... Aging jadval (5 guruh)" — sorted by total outstanding, descending. */
export class AgingReportQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  asOf?: string;
}
