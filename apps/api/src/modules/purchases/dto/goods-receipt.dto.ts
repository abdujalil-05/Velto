import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';
import { IsMoneyAmount, IsQuantity } from '../../../common/validators/numeric-bounds';

/**
 * With a PO: `purchaseOrderLineId` is required and the product comes from that
 * line. Without a PO (ad-hoc delivery): `productId` is required. The service
 * enforces which one applies.
 */
export class CreateGoodsReceiptLineDto {
  @IsOptional()
  @IsUUID()
  purchaseOrderLineId?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsQuantity()
  @IsNumber({ maxDecimalPlaces: 3 })
  qty!: number;

  // Only honoured for ad-hoc receipts; with a PO the cost is the PO line's unitPrice.
  @IsOptional()
  @IsMoneyAmount({ allowZero: true })
  @IsNumber({ maxDecimalPlaces: 2 })
  unitCost?: number;
}

export class CreateGoodsReceiptDto {
  // Idempotency key (per company): a replay returns the stored receipt.
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @IsUUID()
  purchaseOrderId?: string;

  // Required without a PO; with a PO it must equal the PO's warehouse (or be omitted).
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreateGoodsReceiptLineDto)
  lines!: CreateGoodsReceiptLineDto[];
}

export class ListGoodsReceiptsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsUUID()
  purchaseOrderId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
