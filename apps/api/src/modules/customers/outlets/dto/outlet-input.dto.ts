import { Type } from 'class-transformer';
import { IsEnum, IsLatitude, IsLongitude, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { OutletType } from '@velto/database';

export class OutletInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsEnum(OutletType)
  type?: OutletType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;
}
