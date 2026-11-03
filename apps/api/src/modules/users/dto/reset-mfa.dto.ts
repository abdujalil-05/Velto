import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** ADR-058 step-up proof: a challenge from POST /users/:id/mfa/reset/challenge + the OWNER's password and current 6-digit TOTP (no recovery codes). */
export class ResetMfaDto {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  challengeId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  totpCode!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
