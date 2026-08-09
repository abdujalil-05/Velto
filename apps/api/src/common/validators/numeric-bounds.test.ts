import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateOrderLineDto } from '../../modules/sales/dto/create-order-line.dto';
import { CreatePaymentDto } from '../../modules/finance/dto/create-payment.dto';
import { AdjustStockDto } from '../../modules/stock/dto/adjust-stock.dto';

const U = '11111111-1111-4111-8111-111111111111';
const check = (cls: any, obj: any) =>
  validateSync(plainToInstance(cls, obj), { whitelist: true, forbidNonWhitelisted: true })
    .flatMap((e) => Object.keys(e.constraints ?? {}));

describe('numeric bounds', () => {
  it('accepts normal values', () => {
    expect(check(CreateOrderLineDto, { productId: U, packagingId: U, qty: 3, discountPct: 10 })).toEqual([]);
    expect(check(CreatePaymentDto, { customerId: U, amount: 500000, method: 'CASH' })).toEqual([]);
    expect(check(AdjustStockDto, { productId: U, warehouseId: U, qty: -5, reason: 'damage' })).toEqual([]);
  });
  it('rejects overflow, Infinity and NaN', () => {
    expect(check(CreateOrderLineDto, { productId: U, packagingId: U, qty: 1e12 })).toContain('max');
    expect(check(CreatePaymentDto, { customerId: U, amount: 1e18, method: 'CASH' })).toContain('max');
    expect(check(CreatePaymentDto, { customerId: U, amount: Infinity, method: 'CASH' })).toContain('isNumber');
    expect(check(CreatePaymentDto, { customerId: U, amount: 'abc', method: 'CASH' })).toContain('isNumber');
    expect(check(CreatePaymentDto, { customerId: U, amount: -5, method: 'CASH' })).toContain('isPositive');
    expect(check(AdjustStockDto, { productId: U, warehouseId: U, qty: 1e12, reason: 'x' })).toContain('max');
  });
  it('still coerces numeric strings from query/body', () => {
    expect(check(CreateOrderLineDto, { productId: U, packagingId: U, qty: '7' })).toEqual([]);
  });
});
