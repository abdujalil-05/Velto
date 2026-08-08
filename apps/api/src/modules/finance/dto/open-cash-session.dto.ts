import { Type } from 'class-transformer';
import { Min } from 'class-validator';

/** 9.2 "/cash ... Smena ochish". */
export class OpenCashSessionDto {
  @Type(() => Number)
  @Min(0)
  openAmount!: number;
}
