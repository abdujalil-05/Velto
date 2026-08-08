import { Type } from 'class-transformer';
import { IsPositive, IsUUID } from 'class-validator';

export class PurchaseOrderLineInputDto {
  @IsUUID()
  productId!: string;

  @Type(() => Number)
  @IsPositive()
  qty!: number;

  @Type(() => Number)
  @IsPositive()
  unitPrice!: number;
}
