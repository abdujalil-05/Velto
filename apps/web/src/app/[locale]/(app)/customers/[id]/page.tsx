'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, Pencil, ShieldOff, ShieldCheck } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import {
  useCustomerQuery,
  useBlockCustomerMutation,
  useUnblockCustomerMutation,
} from '@/lib/api/customers';
import { errorMessage } from '@/lib/api/client';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { OrderStatusBadge } from '@/components/shared/order-status-badge';
import { BlockCustomerDialog } from '@/components/customers/block-customer-dialog';

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('Customers.detail');
  const tCommon = useTranslations('Common');
  const tOutlet = useTranslations('Customers.form.outletTypes');
  const locale = useLocale();
  const router = useRouter();
  const { hasPermission } = useAuth();

  const { data: customer, isLoading, isError, error, refetch } = useCustomerQuery(id);
  const blockMutation = useBlockCustomerMutation(id);
  const unblockMutation = useUnblockCustomerMutation(id);
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !customer) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>{errorMessage(error, locale)}</span>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t('retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const balance = Number(customer.balance);
  const canUpdate = hasPermission('customers.update');

  return (
    <div className="space-y-4">
      <Link href="/customers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{customer.name}</h1>
            {customer.isBlocked ? (
              <Badge variant="destructive">{t('blocked')}</Badge>
            ) : (
              <Badge variant="success">{t('active')}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{customer.code}</p>
        </div>

        {canUpdate && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => router.push(`/customers/${id}/edit`)}>
              <Pencil className="mr-2 h-4 w-4" />
              {t('edit')}
            </Button>
            {customer.isBlocked ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  unblockMutation.mutate(undefined, {
                    onSuccess: () => toast.success(t('unblockSuccess')),
                    onError: (err) => toast.error(errorMessage(err, locale)),
                  })
                }
                disabled={unblockMutation.isPending}
              >
                <ShieldCheck className="mr-2 h-4 w-4" />
                {t('unblock')}
              </Button>
            ) : (
              <Button variant="destructive" size="sm" onClick={() => setBlockDialogOpen(true)}>
                <ShieldOff className="mr-2 h-4 w-4" />
                {t('block')}
              </Button>
            )}
          </div>
        )}
      </div>

      {customer.isBlocked && customer.blockReason && (
        <Alert variant="destructive">
          <AlertDescription>
            <span className="font-medium">{t('blockReasonLabel')}:</span> {customer.blockReason}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('balance')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-semibold ${balance > 0 ? 'text-destructive' : ''}`}>
              {formatMoney(customer.balance)} <span className="text-sm text-muted-foreground">{tCommon('somUnit')}</span>
            </p>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('contactInfo')}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            <InfoRow label={t('phone')} value={customer.phone} />
            <InfoRow label={t('contactPerson')} value={customer.contactPerson} />
            <InfoRow label={t('priceList')} value={customer.priceList?.name} />
            <InfoRow label={t('paymentTermDays')} value={`${customer.paymentTermDays} ${t('days')}`} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">{t('outlets')}</CardTitle>
        </CardHeader>
        <CardContent>
          {customer.outlets.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noOutlets')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {customer.outlets.map((outlet) => (
                <li key={outlet.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div>
                    <p className="font-medium">{outlet.name}</p>
                    <p className="text-xs text-muted-foreground">{outlet.address ?? '—'}</p>
                  </div>
                  <Badge variant="outline">{tOutlet(outlet.type)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('recentOrders')}</CardTitle>
          </CardHeader>
          <CardContent>
            {customer.recentOrders.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noOrders')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {customer.recentOrders.map((order) => (
                  <li key={order.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div>
                      <p className="font-medium">{order.number}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(order.createdAt, locale)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span>
                        {formatMoney(order.total)} {tCommon('somUnit')}
                      </span>
                      <OrderStatusBadge status={order.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('recentVisits')}</CardTitle>
          </CardHeader>
          <CardContent>
            {customer.recentVisits.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noVisits')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {customer.recentVisits.map((visit) => (
                  <li key={visit.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div>
                      <p className="font-medium">{visit.outlet.name}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(visit.startedAt, locale)}</p>
                    </div>
                    <Badge variant={visit.outcome === 'ORDERED' ? 'success' : 'outline'}>
                      {t(`visitOutcome.${visit.outcome}`)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {customer.lastPayment && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('lastPayment')}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between text-sm">
            <span>
              {customer.lastPayment.number} · {formatDateTime(customer.lastPayment.createdAt, locale)}
            </span>
            <span className="font-medium">
              {formatMoney(customer.lastPayment.amount)} {tCommon('somUnit')}
            </span>
          </CardContent>
        </Card>
      )}

      <BlockCustomerDialog
        open={blockDialogOpen}
        onOpenChange={setBlockDialogOpen}
        isSubmitting={blockMutation.isPending}
        onConfirm={(reason) =>
          blockMutation.mutate(reason, {
            onSuccess: () => {
              toast.success(t('blockSuccess'));
              setBlockDialogOpen(false);
            },
            onError: (err) => toast.error(errorMessage(err, locale)),
          })
        }
      />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p>{value || '—'}</p>
    </div>
  );
}
