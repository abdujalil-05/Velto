import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** One pickup point added to a SupplierRoute — `sequence` is assigned server-side (existing stop count + 1). */
export class CreateSupplierRouteStopDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  pickupAddress!: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;
}
