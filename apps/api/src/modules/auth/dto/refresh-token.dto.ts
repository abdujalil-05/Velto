import { IsOptional, IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  // Optional: a browser client (apps/web) authenticates via the httpOnly
  // refresh cookie set by auth.controller.ts and sends no body at all — only
  // apps/miniapp (which can't reliably rely on cookies inside Telegram's
  // embedded WebView/iframe) still supplies this explicitly.
  @IsOptional()
  @IsString()
  @MinLength(1)
  refreshToken?: string;
}
