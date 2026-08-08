import { IsDateString, IsIn, IsOptional } from 'class-validator';

/** 11.1: "Buxgalter /export/1c'da davrni tanlaydi" — period plus an optional output format (XML is the primary CommerceML2 format, EXCEL the "muqobil" alternative). */
export class CreateExportDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  @IsOptional()
  @IsIn(['XML', 'EXCEL'])
  format?: 'XML' | 'EXCEL';
}
