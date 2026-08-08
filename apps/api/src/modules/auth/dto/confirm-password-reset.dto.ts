import { IsString, Matches, MinLength } from 'class-validator';
import { NotCommonPassword } from '../../../common/validators/not-common-password.validator';

// +998 followed by 9 digits — matches LoginDto/CreateUserDto.
const UZ_PHONE_RE = /^\+998\d{9}$/;

export class ConfirmPasswordResetDto {
  @IsString()
  @Matches(UZ_PHONE_RE, { message: 'phone must be in the format +998XXXXXXXXX' })
  phone!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;

  @IsString()
  @MinLength(10)
  @NotCommonPassword()
  newPassword!: string;
}
