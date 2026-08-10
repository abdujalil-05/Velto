import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { CreateOrderLineDto } from './create-order-line.dto';

export class CreateOrderDto {
  @IsUUID()
  customerId!: string;

  @IsOptional()
  @IsUUID()
  outletId?: string;

  // Optional when the company has exactly one active warehouse (the common
  // case per the ICP's "1-3 ombor") — the service defaults to it. Companies
  // with more than one must specify.
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  // Operator (web) creating on behalf of an agent; ignored/overridden when
  // the caller themselves is a SALES_AGENT (8.1 — agent or operator creates).
  @IsOptional()
  @IsUUID()
  agentId?: string;

  // Kuryer — the own delivery staff User (COURIER role) to hand this order's
  // delivery to, known up front (e.g. an office-entered order routed to a
  // courier immediately). When given, the order skips straight to SHIPPED
  // instead of the usual SUBMITTED — see SalesService.create().
  @IsOptional()
  @IsUUID()
  courierId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  // Offline idempotency key (10.3) — maps 1:1 to SalesOrder.clientId.
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderLineDto)
  lines!: CreateOrderLineDto[];
}
