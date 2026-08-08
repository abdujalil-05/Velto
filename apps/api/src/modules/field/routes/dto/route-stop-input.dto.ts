import { IsUUID } from 'class-validator';

/** Position in the `stops` array is the visiting order — sortOrder is assigned server-side from it. */
export class RouteStopInputDto {
  @IsUUID()
  outletId!: string;
}
