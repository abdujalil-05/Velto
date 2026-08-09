import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsMoneyAmount, IsPercentage } from '../../../../common/validators/numeric-bounds';
import { PackagingDto } from './packaging.dto';

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  brand?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20)
  baseUnit!: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsPercentage()
  vatRate?: number;

  @IsOptional()
  @IsMoneyAmount({ allowZero: true })
  minPrice?: number;

  // The product's sale price — stored as a PriceListItem on the single
  // implicit default price list (see PriceListsService.getOrCreateDefault),
  // not a Product column. Optional: a product can exist before its price
  // is set, same as before this field existed.
  @IsOptional()
  @IsMoneyAmount({ allowZero: true })
  price?: number;

  // 1C export requires this (6.4) — service defaults it to `sku` if omitted.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  externalCode?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PackagingDto)
  packagings!: PackagingDto[];
}
