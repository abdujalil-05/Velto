import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { IsQuantity } from '../../../common/validators/numeric-bounds';

/** 9.2 "/stock/receive ... Forma: mahsulot, miqdor, sabab" (product, quantity, reason). */
export class ReceiveStockDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  warehouseId!: string;

  @IsQuantity()
  qty!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
