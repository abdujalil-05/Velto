import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class IssueMfaEnrollmentCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword!: string;

  /** The actor's current 6-digit TOTP, or one of their recovery codes. */
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  @Matches(/\S/)
  totpCode!: string;
}
