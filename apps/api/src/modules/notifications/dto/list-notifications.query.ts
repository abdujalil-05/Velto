import { IsBoolean, IsOptional } from 'class-validator';
import { ParseBooleanQuery } from '../../../common/decorators/parse-boolean-query.decorator';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

export class ListNotificationsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @ParseBooleanQuery()
  @IsBoolean()
  unreadOnly?: boolean;
}
