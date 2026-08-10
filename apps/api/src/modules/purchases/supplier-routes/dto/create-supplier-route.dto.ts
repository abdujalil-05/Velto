import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** Mirrors CreateRouteDto (field/routes) — same weekday encoding, no supplierId (comes from the path). */
export class CreateSupplierRouteDto {
  // Same encoding as Route.weekday / SupplierRoute.weekday: 1 = Monday .. 7 = Sunday.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  weekday!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
