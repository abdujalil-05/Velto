import { IsUUID } from 'class-validator';
import { IsMoneyAmount, IsQuantity } from '../../../../common/validators/numeric-bounds';

export class PurchaseOrderLineInputDto {
  @IsUUID()
  productId!: string;

  @IsQuantity()
  qty!: number;

  @IsMoneyAmount()
  unitPrice!: number;
}
