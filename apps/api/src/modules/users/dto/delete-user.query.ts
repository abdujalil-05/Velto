import { IsBoolean, IsOptional } from 'class-validator';
import { ParseBooleanQuery } from '../../../common/decorators/parse-boolean-query.decorator';

export class DeleteUserQueryDto {
  /**
   * Opt in to physical deletion. Left off (the default), the service decides:
   * a user with no business records is removed for real, one that owns orders
   * / visits / payments / cash sessions / audit trail is anonymized instead.
   * With `hard=true` an owning user is a 409 rather than a silent soft delete.
   */
  @IsOptional()
  @ParseBooleanQuery()
  @IsBoolean()
  hard?: boolean;
}
