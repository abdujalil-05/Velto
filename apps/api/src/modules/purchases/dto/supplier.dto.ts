import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ParseBooleanQuery } from '../../../common/decorators/parse-boolean-query.decorator';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

export class CreateSupplierDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  inn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class UpdateSupplierDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  inn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ListSuppliersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @ParseBooleanQuery()
  @IsBoolean()
  isActive?: boolean;
}
