import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { DuplicateSkuException, ProductNotFoundException } from '../catalog-exceptions';
import { PriceListsService } from '../price-lists/price-lists.service';
import type { CreateProductDto } from './dto/create-product.dto';
import { ProductsService } from './products.service';

describe('ProductsService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const priceLists = new PriceListsService(tenantPrisma, auditLog);
  const products = new ProductsService(tenantPrisma, auditLog, priceLists);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-products-${Date.now()}`, name: 'Products Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Products Test Co' } });
    companyId = company.id;

    // AuditLog.userId has a real FK to User — a fixture with a fake random
    // UUID would fail every write the moment ProductsService audit-logs it.
    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Test', lastName: 'User', phone: '+998900000000' },
    });
    user = { id: dbUser.id, companyId, firstName: 'Test', lastName: 'User', roles: [], permissions: [] };
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const dto = (sku: string): CreateProductDto => ({
    sku,
    name: `Product ${sku}`,
    baseUnit: 'dona',
    packagings: [{ name: 'dona', qtyInBaseUnit: 1 }],
  });

  it('creates a product, defaulting externalCode to sku and auto-marking the sole packaging as default', async () => {
    const product = await tenantPrisma.run(companyId, () => products.create(dto('P-1'), user));
    expect(product.externalCode).toBe('P-1');
    expect(product.packagings).toHaveLength(1);
    expect(product.packagings[0]?.isDefault).toBe(true);
  });

  it('rejects a duplicate SKU within the same tenant', async () => {
    await expect(tenantPrisma.run(companyId, () => products.create(dto('P-1'), user))).rejects.toBeInstanceOf(
      DuplicateSkuException,
    );
  });

  it('soft-deletes a product, which then disappears from getById', async () => {
    const created = await tenantPrisma.run(companyId, () => products.create(dto('P-2'), user));
    await tenantPrisma.run(companyId, () => products.softDelete(created.id, user));

    await expect(tenantPrisma.run(companyId, () => products.getById(created.id))).rejects.toBeInstanceOf(
      ProductNotFoundException,
    );
  });

  it('a soft-deleted SKU can be reused — uniqueness is a partial index over live rows only', async () => {
    // P-2 was soft-deleted above; the partial unique index
    // (soft_delete_partial_unique migration) only covers deletedAt IS NULL.
    const recreated = await tenantPrisma.run(companyId, () => products.create(dto('P-2'), user));
    expect(recreated.sku).toBe('P-2');
    expect(recreated.deletedAt).toBeNull();
  });
});
