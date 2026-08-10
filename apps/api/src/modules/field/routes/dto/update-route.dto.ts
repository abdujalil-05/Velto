import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { AtMostOneUuidOf } from '../../../../common/validators/mutually-exclusive.validator';
import { RouteStopInputDto } from './route-stop-input.dto';

export class UpdateRouteDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  // Omit both to leave the route's current agent/courier assignment
  // unchanged; set exactly one to reassign it — never both (the DB's
  // `Route_agent_xor_courier_check` CHECK constraint would reject that
  // anyway, this just fails fast with a proper AppException instead).
  @AtMostOneUuidOf('courierId')
  agentId?: string;

  @AtMostOneUuidOf('agentId')
  courierId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  weekday?: number;

  // Full replace, same pattern as PriceLists.upsertItems (9.2) — omit to leave the stop list unchanged.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RouteStopInputDto)
  stops?: RouteStopInputDto[];
}
