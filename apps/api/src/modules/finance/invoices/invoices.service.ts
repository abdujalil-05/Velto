import { Injectable } from '@nestjs/common';
import { Prisma } from '@velto/database';
import { paginate } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { InvoiceNotFoundException } from '../finance-exceptions';
import type { ListInvoicesQueryDto } from '../dto/list-invoices.query';

const INVOICE_LIST_INCLUDE = { allocations: true } satisfies Prisma.InvoiceInclude;
const INVOICE_DETAIL_INCLUDE = {
  lines: true,
  allocations: { include: { payment: true } },
} satisfies Prisma.InvoiceInclude;

@Injectable()
export class InvoicesService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(query: ListInvoicesQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.InvoiceWhereInput = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [data, total] = await Promise.all([
      tx.invoice.findMany({
        where,
        include: INVOICE_LIST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.invoice.count({ where }),
    ]);

    return paginate(data.map(withOutstanding), total, query.page, query.pageSize);
  }

  async getById(id: string) {
    const tx = this.tenantPrisma.client;
    const invoice = await tx.invoice.findFirst({ where: { id }, include: INVOICE_DETAIL_INCLUDE });
    if (!invoice) throw new InvoiceNotFoundException();
    return withOutstanding(invoice);
  }
}

function withOutstanding<T extends { total: Prisma.Decimal; allocations: { amount: Prisma.Decimal }[] }>(invoice: T) {
  const paid = invoice.allocations.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
  return { ...invoice, paid, outstanding: invoice.total.minus(paid) };
}
