import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const TOTP_RE = /^\d{6}$/;
const RECOVERY_RE = /^[a-zA-Z0-9\s-]{8,20}$/;

export class MfaChallengeDto {
  @IsString()
  @MinLength(20)
  @MaxLength(100)
  mfaChallenge!: string;
}

const ENROLLMENT_CODE_RE = /^[a-zA-Z0-9\s-]{8,32}$/;

/** `enrollmentCode` is required for a FIRST enrollment (enforced in MfaService); ignored for self-service re-enroll. */
export class MfaEnrollStartDto extends MfaChallengeDto {
  @IsOptional()
  @IsString()
  @Matches(ENROLLMENT_CODE_RE, { message: 'enrollmentCode has an invalid format' })
  enrollmentCode?: string;
}

export class MfaEnrollConfirmDto extends MfaEnrollStartDto {
  @IsString()
  @Matches(TOTP_RE, { message: 'code must be 6 digits' })
  code!: string;
}

/** Exactly one of `code` / `recoveryCode` (enforced in MfaService). */
export class MfaVerifyDto extends MfaChallengeDto {
  @IsOptional()
  @IsString()
  @Matches(TOTP_RE, { message: 'code must be 6 digits' })
  code?: string;

  @IsOptional()
  @IsString()
  @Matches(RECOVERY_RE, { message: 'recoveryCode has an invalid format' })
  recoveryCode?: string;
}

export class MfaReenrollDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;

  @IsString()
  @Matches(TOTP_RE, { message: 'code must be 6 digits' })
  code!: string;
}

export class RegenerateRecoveryCodesDto {
  @IsString()
  @Matches(TOTP_RE, { message: 'code must be 6 digits' })
  code!: string;
}
