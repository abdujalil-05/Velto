import { IsString, IsUUID, MaxLength, MinLength, NotEquals } from 'class-validator';
import { IsSignedQuantity } from '../../../common/validators/numeric-bounds';

/** Correction (inventory count, damage, loss/gain) — `qty` is signed: positive adds, negative removes. */
export class AdjustStockDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  warehouseId!: string;

  // IsSignedQuantity applies IsNumber first: without it a non-numeric body
  // value becomes NaN here and slips past every downstream Decimal guard.
  @IsSignedQuantity()
  @NotEquals(0)
  qty!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
