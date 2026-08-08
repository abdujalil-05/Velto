import { IsString, Matches } from 'class-validator';

// +998 followed by 9 digits — matches LoginDto/CreateUserDto.
const UZ_PHONE_RE = /^\+998\d{9}$/;

export class RequestPasswordResetDto {
  @IsString()
  @Matches(UZ_PHONE_RE, { message: 'phone must be in the format +998XXXXXXXXX' })
  phone!: string;
}
