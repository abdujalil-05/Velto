import { ArrayMinSize, ArrayUnique, IsArray, IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { NotCommonPassword } from '../../../common/validators/not-common-password.validator';

const UZ_PHONE_RE = /^\+998\d{9}$/;

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Matches(UZ_PHONE_RE, { message: 'phone must be in the format +998XXXXXXXXX' })
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string;

  // Omit to leave the password unchanged; activation/deactivation (session
  // revocation) is handled separately by the dedicated endpoints.
  @IsOptional()
  @IsString()
  @MinLength(10)
  @NotCommonPassword()
  password?: string;

  // When present, replaces the user's role set entirely.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  roleCodes?: string[];
}
