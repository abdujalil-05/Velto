import { Type } from 'class-transformer';
import { Min } from 'class-validator';

/** 9.2 "/cash ... yopish". */
export class CloseCashSessionDto {
  @Type(() => Number)
  @Min(0)
  closeAmount!: number;
}
