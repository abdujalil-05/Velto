import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

/** Non-negative `Decimal(18,3)` as a string — never a JS float (§6.6). */
const DELIVERED_QTY_PATTERN = /^\d{1,15}(\.\d{1,3})?$/;

export class DeliverOrderLineDto {
  @IsUUID()
  lineId!: string;

  // Base units, same unit as SalesOrderLine.qty (packaging already converted at create()).
  @IsString()
  @Matches(DELIVERED_QTY_PATTERN)
  deliveredQty!: string;
}

/**
 * F2.4 partial goods issue. No `lines` ⇒ every line delivered in full.
 * When `lines` is given it must list every order line exactly once.
 */
export class DeliverOrderDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => DeliverOrderLineDto)
  lines?: DeliverOrderLineDto[];
}
