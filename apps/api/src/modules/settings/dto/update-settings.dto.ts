import { IsInt, IsOptional, IsString, Max, Min, MaxLength, MinLength } from 'class-validator';
import { IsPercentage } from '../../../common/validators/numeric-bounds';

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
  @IsPercentage()
  defaultVatRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  docPrefix?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  // F3: visit geofence radius (m) and max accepted GPS accuracy (m); mirror DB CHECKs.
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(5000)
  visitGpsRadiusM?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1000)
  gpsMaxAccuracyM?: number;
}
