import { Injectable } from '@nestjs/common';
import { Prisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { paginate } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../../customers/customers.service';
import { InvoiceNotFoundException } from '../finance-exceptions';
import type { ListInvoicesQueryDto } from '../dto/list-invoices.query';

const INVOICE_LIST_INCLUDE = { allocations: true } satisfies Prisma.InvoiceInclude;
const INVOICE_DETAIL_INCLUDE = {
  lines: true,
  allocations: { include: { payment: true } },
} satisfies Prisma.InvoiceInclude;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly customers: CustomersService,
  ) {}

  /**
   * SEC-023 (15.3): an invoice carries no agent of its own, so a SALES_AGENT's
   * visible invoices are those of the customers they can already see — the
   * exact same predicate CustomersService uses (own routes / own orders / own
   * visits), so the two views can't drift apart. All other roles are
   * unrestricted.
   */
  private agentScope(user: AuthenticatedUser): Prisma.InvoiceWhereInput {
    if (!user.roles.includes('SALES_AGENT')) return {};
    return { customer: this.customers.agentScope(user.id) };
  }

  async list(query: ListInvoicesQueryDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.InvoiceWhereInput = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...this.agentScope(user),
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

  async getById(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // Out-of-scope for this agent looks identical to nonexistent — the
    // response never confirms another agent's customer has this invoice.
    const invoice = await tx.invoice.findFirst({
      where: { id, ...this.agentScope(user) },
      include: INVOICE_DETAIL_INCLUDE,
    });
    if (!invoice) throw new InvoiceNotFoundException();
    return withOutstanding(invoice);
  }
}

function withOutstanding<T extends { total: Prisma.Decimal; allocations: { amount: Prisma.Decimal }[] }>(invoice: T) {
  const paid = invoice.allocations.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
  return { ...invoice, paid, outstanding: invoice.total.minus(paid) };
}
