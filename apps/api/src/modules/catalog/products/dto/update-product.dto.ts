import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsMoneyAmount, IsPercentage } from '../../../../common/validators/numeric-bounds';
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
  @IsPercentage()
  vatRate?: number;

  @IsOptional()
  @IsMoneyAmount({ allowZero: true })
  minPrice?: number;

  // See create-product.dto.ts — stored as a PriceListItem, not a column.
  @IsOptional()
  @IsMoneyAmount({ allowZero: true })
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
