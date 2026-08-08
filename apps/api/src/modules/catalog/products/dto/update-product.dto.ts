import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
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

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  brand?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  baseUnit?: string;

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

  // See create-product.dto.ts — stored as a PriceListItem, not a column.
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  externalCode?: string;

  // Omit to leave packagings unchanged; provide the full replacement set otherwise.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PackagingDto)
  packagings?: PackagingDto[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
