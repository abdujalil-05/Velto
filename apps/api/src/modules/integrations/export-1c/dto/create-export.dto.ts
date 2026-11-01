import { IsDateString, IsIn, IsOptional } from 'class-validator';

/** 11.1: "Buxgalter /export/1c'da davrni tanlaydi" — period plus an optional output format (required, no default: EXCEL = informational register only, CSV flat fallback, XML CommerceML2 - not pilot-validated; missing -> 400 1C_EXPORT_FORMAT_REQUIRED from the service). */
export class CreateExportDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  @IsOptional()
  @IsIn(['XML', 'EXCEL', 'CSV'])
  format?: 'XML' | 'EXCEL' | 'CSV';
}
