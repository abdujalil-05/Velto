import { describe, expect, it } from 'vitest';
import { DELIVERED_QTY_CHECK, isDeliveredQtyCheckViolation } from './delivered-qty-check';

describe('isDeliveredQtyCheckViolation', () => {
  it('matches the constraint name in message, meta or cause', () => {
    expect(isDeliveredQtyCheckViolation(new Error(`violates check constraint "${DELIVERED_QTY_CHECK}"`))).toBe(true);
    expect(isDeliveredQtyCheckViolation({ message: 'x', meta: { constraint: DELIVERED_QTY_CHECK } })).toBe(true);
    expect(isDeliveredQtyCheckViolation({ message: 'x', cause: new Error(DELIVERED_QTY_CHECK) })).toBe(true);
  });

  it('matches SQLSTATE 23514 on code/meta.code when the text names SalesOrderLine.deliveredQty', () => {
    const text = 'new row for relation "SalesOrderLine" violates check constraint on "deliveredQty"';
    expect(isDeliveredQtyCheckViolation({ code: '23514', message: text })).toBe(true);
    expect(isDeliveredQtyCheckViolation({ code: 'P2010', message: text, meta: { code: '23514' } })).toBe(true);
    expect(isDeliveredQtyCheckViolation({ message: `Code: \`23514\`. ${text}` })).toBe(true);
  });

  it('rejects other errors (no false positives)', () => {
    expect(isDeliveredQtyCheckViolation(undefined)).toBe(false);
    expect(isDeliveredQtyCheckViolation('SalesOrderLine_deliveredQty_range_check')).toBe(false);
    // 23514 on a different table/constraint
    expect(
      isDeliveredQtyCheckViolation({
        code: '23514',
        message: 'new row for relation "Route" violates check constraint "Route_agent_xor_courier_check"',
      }),
    ).toBe(false);
    // 23514 on SalesOrderLine but another column
    expect(
      isDeliveredQtyCheckViolation({
        code: '23514',
        message: 'new row for relation "SalesOrderLine" violates check constraint "SalesOrderLine_qty_check"',
      }),
    ).toBe(false);
    // mentions deliveredQty but is not a check violation (unique / generic)
    expect(isDeliveredQtyCheckViolation({ code: 'P2002', message: 'Unique constraint failed on deliveredQty of SalesOrderLine' })).toBe(false);
    expect(isDeliveredQtyCheckViolation(new Error('deliveredQty out of range on SalesOrderLine'))).toBe(false);
  });
});
