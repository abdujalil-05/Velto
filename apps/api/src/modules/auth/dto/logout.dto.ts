import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class LogoutDto {
  // Optional for the same reason as RefreshTokenDto: web clients identify
  // the session via the httpOnly refresh cookie instead of the body.
  @IsOptional()
  @IsString()
  @MinLength(1)
  refreshToken?: string;

  /** SEC-010..019: "barcha qurilmadan logout" — revokes the whole refresh-token family, not just this device. */
  @IsOptional()
  @IsBoolean()
  allDevices?: boolean;
}
