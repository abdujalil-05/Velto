import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsQuantity } from '../../../../common/validators/numeric-bounds';

/** 6.4: dona → blok → quti. `qtyInBaseUnit` converts this packaging to the product's baseUnit. */
export class PackagingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name!: string;

  @IsQuantity()
  qtyInBaseUnit!: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
