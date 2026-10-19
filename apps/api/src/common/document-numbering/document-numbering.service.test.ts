import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { DocumentNumberingService } from './document-numbering.service';

describe('DocumentNumberingService (integration)', () => {
  let companyId: string;
  const tenantPrisma = new TenantPrismaService();
  const numbering = new DocumentNumberingService();

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-docnum-${Date.now()}`, name: 'DocNum' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'DocNum Co' } })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('OB is an independent OB-{YYYY}-{6} sequence that does not disturb INV/SO', async () => {
    const year = new Date().getFullYear();
    const next = (t: 'OB' | 'INV' | 'SO') => tenantPrisma.run(companyId, (tx) => numbering.next(tx, companyId, t));
    expect(await next('INV')).toBe(`INV-${year}-000001`);
    expect(await next('OB')).toBe(`OB-${year}-000001`);
    expect(await next('OB')).toBe(`OB-${year}-000002`);
    expect(await next('INV')).toBe(`INV-${year}-000002`);
    expect(await next('SO')).toBe(`SO-${year}-000001`);
  });
});
