'use client';

import { useTranslations } from 'next-intl';
import { Pencil, Power, Send } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SortableHeader } from '@/components/shared/sortable-header';
import { useRoutesQuery } from '@/lib/api/routes';
import { useOrdersQuery } from '@/lib/api/orders';
import type { SortState } from '@/lib/hooks/use-sort';
import { courierName, type Courier } from '@/lib/api/couriers';

interface CouriersTableProps {
  couriers: Courier[];
  canUpdate: boolean;
  /** `users.read` — gates the Telegram column and the dialog trigger. */
  canReadTelegram: boolean;
  onEdit: (courier: Courier) => void;
  onToggleActive: (courier: Courier) => void;
  onOpenTelegram: (courier: Courier) => void;
  togglingId?: string;
  sort: SortState;
  onSort: (column: string) => void;
}

export function CouriersTable({
  couriers,
  canUpdate,
  canReadTelegram,
  onEdit,
  onToggleActive,
  onOpenTelegram,
  togglingId,
  sort,
  onSort,
}: CouriersTableProps) {
  const t = useTranslations('Couriers');
  const showActions = canUpdate || canReadTelegram;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <SortableHeader column="firstName" sort={sort} onSort={onSort}>
              {t('name')}
            </SortableHeader>
            <th className="pb-2 pr-3 font-medium">{t('phone')}</th>
            <th className="pb-2 pr-3 font-medium">{t('routes')}</th>
            <th className="pb-2 pr-3 font-medium">{t('orders')}</th>
            {canReadTelegram && <th className="pb-2 pr-3 font-medium">{t('telegram.column')}</th>}
            <th className="pb-2 pr-3 font-medium">{t('status')}</th>
            {showActions && <th className="pb-2 text-right font-medium">{t('actions')}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {couriers.map((courier) => (
            <tr key={courier.id} className="hover:bg-accent/50">
              <td className="py-2 pr-3 font-medium">{courierName(courier)}</td>
              <td className="py-2 pr-3 text-muted-foreground">{courier.phone || '—'}</td>
              <td className="py-2 pr-3">
                <CourierRouteCount courierId={courier.id} />
              </td>
              <td className="py-2 pr-3">
                <CourierOrderCount courierId={courier.id} />
              </td>
              {canReadTelegram && (
                <td className="py-2 pr-3">
                  {courier.telegramLinked ? (
                    <Badge variant="success">{t('telegram.linked')}</Badge>
                  ) : (
                    <span className="text-muted-foreground">{t('telegram.notLinked')}</span>
                  )}
                </td>
              )}
              <td className="py-2 pr-3">
                <Badge variant={courier.isActive ? 'success' : 'outline'}>
                  {courier.isActive ? t('active') : t('inactive')}
                </Badge>
              </td>
              {showActions && (
                <td className="py-2 text-right">
                  <div className="flex justify-end gap-1">
                    {canReadTelegram && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onOpenTelegram(courier)}
                        aria-label={t('telegram.action')}
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    )}
                    {canUpdate && (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => onEdit(courier)} aria-label={t('edit')}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onToggleActive(courier)}
                          disabled={togglingId === courier.id}
                          aria-label={courier.isActive ? t('deactivate') : t('activate')}
                        >
                          <Power className={courier.isActive ? 'h-4 w-4 text-destructive' : 'h-4 w-4 text-success'} />
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

function CourierRouteCount({ courierId }: { courierId: string }) {
  const t = useTranslations('Couriers');
  const { data, isLoading } = useRoutesQuery({ courierId, page: 1, pageSize: 1 });

  if (isLoading) return <span className="text-muted-foreground">…</span>;
  const count = data?.meta.total ?? 0;
  return count > 0 ? (
    <Link href={{ pathname: '/routes', query: { courierId } }} className="text-primary hover:underline">
      {t('routeCount', { count })}
    </Link>
  ) : (
    <span className="text-muted-foreground">{t('noRoutes')}</span>
  );
}

/** `GET /orders?courierId=…` with `pageSize: 1` — only `meta.total` is used. */
function CourierOrderCount({ courierId }: { courierId: string }) {
  const t = useTranslations('Couriers');
  const { data, isLoading } = useOrdersQuery({ courierId, page: 1, pageSize: 1 });

  if (isLoading) return <span className="text-muted-foreground">…</span>;
  const count = data?.meta.total ?? 0;
  return count > 0 ? (
    <Link href={{ pathname: '/orders', query: { courierId } }} className="text-primary hover:underline">
      {t('orderCount', { count })}
    </Link>
  ) : (
    <span className="text-muted-foreground">{t('noOrders')}</span>
  );
}
