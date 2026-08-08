import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { RouteStopInputDto } from './route-stop-input.dto';

/** 9.2 "/routes ... Marshrut yaratish/tahrirlash, nuqta biriktirish". */
export class CreateRouteDto {
  @IsUUID()
  agentId!: string;

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
