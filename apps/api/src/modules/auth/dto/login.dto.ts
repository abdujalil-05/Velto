import { IsString, Matches, MinLength } from 'class-validator';

// +998 followed by 9 digits — matches how phone is stored throughout (seed, Customer, etc.)
const UZ_PHONE_RE = /^\+998\d{9}$/;

export class LoginDto {
  @IsString()
  @Matches(UZ_PHONE_RE, { message: 'phone must be in the format +998XXXXXXXXX' })
  phone!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
