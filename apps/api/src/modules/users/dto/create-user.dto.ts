import { ArrayMinSize, ArrayUnique, IsArray, IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { NotCommonPassword } from '../../../common/validators/not-common-password.validator';

// +998 followed by 9 digits — matches how phone is stored throughout (seed, Customer, LoginDto).
const UZ_PHONE_RE = /^\+998\d{9}$/;

export class CreateUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsString()
  @Matches(UZ_PHONE_RE, { message: 'phone must be in the format +998XXXXXXXXX' })
  phone!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string;

  // Optional: an agent (4.1, SALES_AGENT) typically authenticates via Telegram
  // initData (15.2), not a password — see User.passwordHash comment in schema.
  @IsOptional()
  @IsString()
  @MinLength(10)
  @NotCommonPassword()
  password?: string;

  // 9.2 "CRUD, rolga biriktirish" — assigns existing system roles (4.1); a
  // user must have at least one to be able to do anything.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  roleCodes!: string[];
}
