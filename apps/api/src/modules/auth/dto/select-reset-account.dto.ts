import { IsString, MaxLength, MinLength } from 'class-validator';
import { NotCommonPassword } from '../../../common/validators/not-common-password.validator';

export class SelectResetAccountDto {
  @IsString()
  @MinLength(20)
  @MaxLength(100)
  resetHandle!: string;

  @IsString()
  @MinLength(20)
  @MaxLength(100)
  optionId!: string;

  @IsString()
  @MinLength(10)
  @NotCommonPassword()
  newPassword!: string;
}
