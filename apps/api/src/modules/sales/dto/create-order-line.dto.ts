import { Type } from 'class-transformer';
import { IsOptional, IsPositive, IsUUID, Max, Min } from 'class-validator';

export class CreateOrderLineDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  packagingId!: string;

  // Quantity in the chosen packaging unit (e.g. "3 blok") — the service
  // converts to base units via ProductPackaging.qtyInBaseUnit (8.1).
  @Type(() => Number)
  @IsPositive()
  qty!: number;

  // MVP: simple percentage discount only (5.4 — no promotions/tiers yet).
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  discountPct?: number;
}
