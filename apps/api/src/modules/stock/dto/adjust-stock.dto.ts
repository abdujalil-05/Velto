import { Type } from 'class-transformer';
import { IsNumber, IsString, IsUUID, Max, MaxLength, Min, MinLength, NotEquals } from 'class-validator';

/** Correction (inventory count, damage, loss/gain) — `qty` is signed: positive adds, negative removes. */
export class AdjustStockDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  warehouseId!: string;

  // @IsNumber first: without it a non-numeric body value becomes NaN here and
  // slips past every downstream Decimal guard.
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @NotEquals(0)
  @Min(-1_000_000_000)
  @Max(1_000_000_000)
  qty!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
