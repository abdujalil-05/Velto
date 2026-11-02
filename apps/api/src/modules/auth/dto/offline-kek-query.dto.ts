import { IsOptional, Matches } from 'class-validator';

export class OfflineKekQueryDto {
  // Strict decimal integer >= 1 (no signs, decimals, exponents, leading zeros). Parsed by the service.
  @IsOptional()
  @Matches(/^[1-9]\d{0,8}$/, { message: 'version must be a positive integer' })
  version?: string;
}
