import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
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
  @Type(() => Number)
  @Min(0)
  @Max(100)
  vatRate?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  minPrice?: number;

  // The product's sale price — stored as a PriceListItem on the single
  // implicit default price list (see PriceListsService.getOrCreateDefault),
  // not a Product column. Optional: a product can exist before its price
  // is set, same as before this field existed.
  @IsOptional()
  @Type(() => Number)
  @Min(0)
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
