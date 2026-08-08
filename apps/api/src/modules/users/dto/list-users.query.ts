import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ParseBooleanQuery } from '../../../common/decorators/parse-boolean-query.decorator';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @ParseBooleanQuery()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  roleCode?: string;
}
