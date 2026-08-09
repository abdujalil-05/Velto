import { IsOptional, IsUUID } from 'class-validator';
import { IsPercentage, IsQuantity } from '../../../common/validators/numeric-bounds';

export class CreateOrderLineDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  packagingId!: string;

  // Quantity in the chosen packaging unit (e.g. "3 blok") — the service
  // converts to base units via ProductPackaging.qtyInBaseUnit (8.1).
  @IsQuantity()
  qty!: number;

  // MVP: simple percentage discount only (5.4 — no promotions/tiers yet).
  @IsOptional()
  @IsPercentage()
  discountPct?: number;
}
