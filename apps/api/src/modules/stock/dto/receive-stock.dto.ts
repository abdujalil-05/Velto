import { Type } from 'class-transformer';
import { IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';

/** 9.2 "/stock/receive ... Forma: mahsulot, miqdor, sabab" (product, quantity, reason). */
export class ReceiveStockDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  warehouseId!: string;

  @Type(() => Number)
  @IsPositive()
  qty!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
