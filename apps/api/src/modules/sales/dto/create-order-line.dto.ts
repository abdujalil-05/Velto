import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { IsPercentage, IsQuantity } from '../../../common/validators/numeric-bounds';

/** Non-negative money string fitting `Decimal(18,2)` (≤16 integer digits, ≤2 fraction digits). */
export const MONEY_STRING_RE = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

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

  // F4: the per-base-unit price the agent saw and confirmed offline (same
  // unit as PriceListItem.price / GET /sync/pull `prices[].price`), as a
  // decimal string. Never used to price the line — only compared with the
  // server-resolved price; any difference → 409 PRICE_CHANGED, nothing
  // written. Optional so non-sync API callers stay backward compatible.
  @IsOptional()
  @IsString()
  @Matches(MONEY_STRING_RE)
  expectedUnitPrice?: string;
}
