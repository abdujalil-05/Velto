import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateOrderLineDto } from '../../modules/sales/dto/create-order-line.dto';
import { CreatePaymentDto } from '../../modules/finance/dto/create-payment.dto';
import { CreatePurchaseOrderLineDto } from '../../modules/purchases/dto/purchase-order.dto';
import { CreateProductDto } from '../../modules/catalog/products/dto/create-product.dto';
import { UpdateSettingsDto } from '../../modules/settings/dto/update-settings.dto';
import { validatePayload } from '../../modules/sync/validate-payload';
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

  describe('scale (ADR-059a): reject, never round', () => {
    const pay = (amount: unknown) => check(CreatePaymentDto, { customerId: U, amount, method: 'CASH' });
    const line = (qty: unknown) => check(CreateOrderLineDto, { productId: U, packagingId: U, qty });
    it('money max 2dp', () => {
      expect(pay(100.005)).toContain('maxScale');
      expect(pay(100.01)).toEqual([]);
      expect(pay('100.10')).toEqual([]);
      expect(pay('100.005')).toContain('maxScale');
      expect(pay(3.3333333333333335)).toContain('maxScale');
      expect(pay(1e-7)).toContain('maxScale');
      expect(pay('1e2')).toContain('maxScale');
    });
    it('strings a double cannot hold exactly are rejected, never altered', () => {
      expect(pay('999999999999999.99')).toContain('isNumber');
      expect(pay('12345678901234567.89')).toContain('isNumber');
      expect(pay('999999999999999.5')).toEqual([]);
    });
    it('quantity max 3dp', () => {
      expect(line(1.0005)).toContain('maxScale');
      expect(line(1.666)).toEqual([]);
    });
    it('percent max 2dp', () => {
      const d = (discountPct: unknown) => check(CreateOrderLineDto, { productId: U, packagingId: U, qty: 1, discountPct });
      expect(d(10.555)).toContain('maxScale');
      expect(d(10.55)).toEqual([]);
    });
    it('message names field and allowed decimals in uz/ru/en', () => {
      const e = validateSync(plainToInstance(CreatePaymentDto, { customerId: U, amount: 1.005, method: 'CASH' }));
      const m = e[0]!.constraints!.maxScale!;
      expect(m).toMatch(/amount.*2.*kasr.*знаков.*decimal places/s);
    });
    it('module families: purchases, catalog, settings, stock', () => {
      expect(check(CreatePurchaseOrderLineDto, { productId: U, qty: 1.0005, unitPrice: 1 })).toContain("maxScale");
      expect(check(CreateProductDto, { name: 'x', sku: 'x', unit: 'pcs', price: 10.005 } as any)).toContain('maxScale');
      expect(check(UpdateSettingsDto, { defaultVatRate: 12.345 })).toContain('maxScale');
      expect(check(AdjustStockDto, { productId: U, warehouseId: U, qty: -5.0001, reason: 'x' })).toContain('maxScale');
    });

    it('payment string amount: DTO and sync validatePayload', async () => {
      expect(check(CreatePaymentDto, { customerId: U, amount: '100.05', method: 'CASH' })).toEqual([]);
      expect(check(CreatePaymentDto, { customerId: U, amount: '100.005', method: 'CASH' })).toContain('maxScale');
      const ok = await validatePayload(CreatePaymentDto, { customerId: U, amount: '100.05', method: 'CASH' });
      expect(ok.amount).toBe(100.05);
      await expect(validatePayload(CreatePaymentDto, { customerId: U, amount: '100.005', method: 'CASH' })).rejects.toMatchObject({
        response: { code: 'SYNC_VALIDATION_FAILED' },
      });
    });
  });
});
