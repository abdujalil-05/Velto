import { IsUUID } from 'class-validator';

/** Body of `POST /orders/:id/assign-supplier` — attaches a deliverer Supplier to an already-created order. */
export class AssignSupplierDto {
  @IsUUID()
  supplierId!: string;
}
