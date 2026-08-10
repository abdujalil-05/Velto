import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { ExactlyOneUuidOf } from '../../../../common/validators/mutually-exclusive.validator';
import { RouteStopInputDto } from './route-stop-input.dto';

/**
 * 9.2 "/routes ... Marshrut yaratish/tahrirlash, nuqta biriktirish".
 * Exactly one of `agentId` / `supplierId` — a route is served either by an
 * own field agent or handed to a yetkazib beruvchi ("deliverer"), matching
 * the DB's `Route_agent_xor_supplier_check` CHECK constraint.
 */
export class CreateRouteDto {
  @ExactlyOneUuidOf('supplierId')
  agentId?: string;

  @ExactlyOneUuidOf('agentId')
  supplierId?: string;

  // 6.8: "weekday Int /* 1-7 */"
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  weekday!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RouteStopInputDto)
  stops!: RouteStopInputDto[];
}
