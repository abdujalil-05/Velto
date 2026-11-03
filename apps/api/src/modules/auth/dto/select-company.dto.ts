import { IsString, MaxLength, MinLength } from 'class-validator';

export class SelectCompanyDto {
  @IsString()
  @MinLength(20)
  @MaxLength(100)
  challengeId!: string;

  @IsString()
  @MinLength(20)
  @MaxLength(100)
  optionId!: string;
}
