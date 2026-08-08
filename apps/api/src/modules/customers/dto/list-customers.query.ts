import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ParseBooleanQuery } from '../../../common/decorators/parse-boolean-query.decorator';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

export class ListCustomersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @ParseBooleanQuery()
  @IsBoolean()
  isBlocked?: boolean;
}
