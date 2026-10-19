import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CancelOrderDto } from './cancel-order.dto';

const check = (body: object) => validate(plainToInstance(CancelOrderDto, body));

describe('CancelOrderDto (F-ORD-002)', () => {
  it('rejects a missing reason', async () => expect(await check({})).not.toHaveLength(0));
  it('rejects a too short / whitespace-only reason', async () => {
    expect(await check({ reason: 'ab' })).not.toHaveLength(0);
    expect(await check({ reason: '   a   ' })).not.toHaveLength(0);
  });
  it('rejects a reason over 500 chars', async () => expect(await check({ reason: 'x'.repeat(501) })).not.toHaveLength(0));
  it('accepts and trims a valid reason', async () => {
    const dto = plainToInstance(CancelOrderDto, { reason: '  customer refused  ' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.reason).toBe('customer refused');
  });
});
