import { IsDateString, IsOptional } from 'class-validator';

/** Both bounds optional — services fall back to a default window (report-utils.resolveDateRange). */
export class DateRangeQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
