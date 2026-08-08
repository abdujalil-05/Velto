import { Type } from 'class-transformer';
import { IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

// 6.2 Company fields — deliberately excludes tenantId/plan/isActive, which
// are platform-admin concerns ([v1.1] full UI per 4.1, DB-level only in MVP).
export class UpdateSettingsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  defaultVatRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  docPrefix?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
