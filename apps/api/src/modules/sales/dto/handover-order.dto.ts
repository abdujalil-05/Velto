import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Body of `POST /orders/:id/handover` (ADR-069/070). Both fields optional:
 * `courierId` is a compare-and-set guard against the assigned courier,
 * `note` (trimmed, ≤500) goes to the audit record only.
 */
export class HandoverOrderDto {
  @IsOptional()
  @IsUUID()
  courierId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  note?: string;
}
