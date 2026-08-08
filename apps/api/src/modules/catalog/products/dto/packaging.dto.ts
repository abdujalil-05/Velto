import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';

/** 6.4: dona → blok → quti. `qtyInBaseUnit` converts this packaging to the product's baseUnit. */
export class PackagingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name!: string;

  @Type(() => Number)
  @IsPositive()
  qtyInBaseUnit!: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
