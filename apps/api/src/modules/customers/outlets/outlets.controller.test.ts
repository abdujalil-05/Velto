import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { REQUIRE_PERMISSION_KEY } from '../../../common/decorators/require-permission.decorator';
import { OutletsQualityController } from './outlets.controller';

// customers.update is held only by OWNER (ALL) and SALES_DIRECTOR in rbac-catalog.ts;
// SALES_AGENT, COURIER, CASHIER, ACCOUNTANT (customers.read only) therefore get 403.
describe('GET /outlets/no-coords RBAC', () => {
  it('requires customers.update, not customers.read', () => {
    const perm = Reflect.getMetadata(REQUIRE_PERMISSION_KEY, OutletsQualityController.prototype.noCoords);
    expect(perm).toBe('customers.update');
  });
});
