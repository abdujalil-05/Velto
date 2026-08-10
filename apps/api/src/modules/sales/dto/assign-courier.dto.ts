import { IsUUID } from 'class-validator';

/** Body of `POST /orders/:id/assign-courier` — attaches a delivery Courier (an own User holding the COURIER role) to an already-created order. */
export class AssignCourierDto {
  @IsUUID()
  courierId!: string;
}
