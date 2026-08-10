'use client';

import { useTranslations } from 'next-intl';
import { Pencil, Power, Send } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SortableHeader } from '@/components/shared/sortable-header';
import { useRoutesQuery } from '@/lib/api/routes';
import type { SortState } from '@/lib/hooks/use-sort';
import { useSupplierTelegramQuery, type Supplier } from '@/lib/api/suppliers';

interface SuppliersTableProps {
  suppliers: Supplier[];
  canUpdate: boolean;
  /** `purchases.read` — gates the Telegram column and the dialog trigger. */
  canReadTelegram: boolean;
  onEdit: (supplier: Supplier) => void;
  onToggleActive: (supplier: Supplier) => void;
  onOpenTelegram: (supplier: Supplier) => void;
  togglingId?: string;
  sort: SortState;
  onSort: (column: string) => void;
  /** Orders where this supplier is the deliverer, keyed by supplier id — computed page-side (see suppliers/page.tsx: `GET /orders` has no `supplierId` filter). */
  orderCountBySupplierId: Map<string, number>;
}

export function SuppliersTable({
  suppliers,
  canUpdate,
  canReadTelegram,
  onEdit,
  onToggleActive,
  onOpenTelegram,
  togglingId,
  sort,
  onSort,
  orderCountBySupplierId,
}: SuppliersTableProps) {
  const t = useTranslations('Suppliers');
  const showActions = canUpdate || canReadTelegram;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <SortableHeader column="name" sort={sort} onSort={onSort}>
              {t('name')}
            </SortableHeader>
            <th className="pb-2 pr-3 font-medium">{t('phone')}</th>
            <th className="pb-2 pr-3 font-medium">{t('address')}</th>
            <th className="pb-2 pr-3 font-medium">{t('routes')}</th>
            <th className="pb-2 pr-3 font-medium">{t('orders')}</th>
            {canReadTelegram && <th className="pb-2 pr-3 font-medium">{t('telegram.column')}</th>}
            <th className="pb-2 pr-3 font-medium">{t('status')}</th>
            {showActions && <th className="pb-2 text-right font-medium">{t('actions')}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {suppliers.map((supplier) => (
            <tr key={supplier.id} className="hover:bg-accent/50">
              <td className="py-2 pr-3 font-medium">{supplier.name}</td>
              <td className="py-2 pr-3 text-muted-foreground">{supplier.phone || '—'}</td>
              <td className="py-2 pr-3 text-muted-foreground">{supplier.address || '—'}</td>
              <td className="py-2 pr-3">
                <SupplierRouteCount supplierId={supplier.id} />
              </td>
              <td className="py-2 pr-3">
                <SupplierOrderCount count={orderCountBySupplierId.get(supplier.id) ?? 0} supplierId={supplier.id} />
              </td>
              {canReadTelegram && (
                <td className="py-2 pr-3">
                  <SupplierTelegramCell supplierId={supplier.id} />
                </td>
              )}
              <td className="py-2 pr-3">
                <Badge variant={supplier.isActive ? 'success' : 'outline'}>
                  {supplier.isActive ? t('active') : t('inactive')}
                </Badge>
              </td>
              {showActions && (
                <td className="py-2 text-right">
                  <div className="flex justify-end gap-1">
                    {canReadTelegram && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onOpenTelegram(supplier)}
                        aria-label={t('telegram.action')}
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    )}
                    {canUpdate && (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => onEdit(supplier)} aria-label={t('edit')}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onToggleActive(supplier)}
                          disabled={togglingId === supplier.id}
                          aria-label={supplier.isActive ? t('deactivate') : t('activate')}
                        >
                          <Power className={supplier.isActive ? 'h-4 w-4 text-destructive' : 'h-4 w-4 text-success'} />
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SupplierRouteCount({ supplierId }: { supplierId: string }) {
  const t = useTranslations('Suppliers');
  const { data, isLoading } = useRoutesQuery({ supplierId, page: 1, pageSize: 1 });

  if (isLoading) return <span className="text-muted-foreground">…</span>;
  const count = data?.meta.total ?? 0;
  return count > 0 ? (
    <Link href={{ pathname: '/routes', query: { supplierId } }} className="text-primary hover:underline">
      {t('routeCount', { count })}
    </Link>
  ) : (
    <span className="text-muted-foreground">{t('noRoutes')}</span>
  );
}

/**
 * `GET /suppliers` doesn't carry link state, so each row asks for its own —
 * same per-row fetch shape as `SupplierRouteCount` above.
 */
function SupplierTelegramCell({ supplierId }: { supplierId: string }) {
  const t = useTranslations('Suppliers');
  const { data, isLoading } = useSupplierTelegramQuery(supplierId);

  if (isLoading) return <span className="text-muted-foreground">…</span>;
  if (!data?.linked) return <span className="text-muted-foreground">{t('telegram.notLinked')}</span>;

  return (
    <Badge variant="success">{data.username ? `@${data.username}` : (data.telegramId ?? t('telegram.linked'))}</Badge>
  );
}

function SupplierOrderCount({ count, supplierId }: { count: number; supplierId: string }) {
  const t = useTranslations('Suppliers');
  return count > 0 ? (
    <Link href={{ pathname: '/orders', query: { supplierId } }} className="text-primary hover:underline">
      {t('orderCount', { count })}
    </Link>
  ) : (
    <span className="text-muted-foreground">{t('noOrders')}</span>
  );
}
