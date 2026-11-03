import { CancelOrderDto } from './cancel-order.dto';

/** Body of `POST /orders/:id/return-to-warehouse` — same mandatory reason rule as cancel (trimmed, 3..500). */
export class ReturnToWarehouseDto extends CancelOrderDto {}
