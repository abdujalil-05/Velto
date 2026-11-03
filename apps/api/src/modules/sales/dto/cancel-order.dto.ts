import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

// F-ORD-002 / ADR-044: cancel reason is mandatory (trimmed, 3..500).
export class CancelOrderDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
