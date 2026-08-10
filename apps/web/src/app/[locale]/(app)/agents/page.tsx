'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, RefreshCw, Search, UserCog } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { useUsersQuery, useDeleteUserMutation, type User } from '@/lib/api/users';
import { useDashboardQuery } from '@/lib/api/dashboard';
import { errorMessage } from '@/lib/api/client';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { exportToCsv } from '@/lib/export-csv';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { ExportCsvButton } from '@/components/shared/export-csv-button';
import { AgentsTable } from '@/components/agents/agents-table';
import { cn } from '@/lib/utils';

export default function AgentsPage() {
  const t = useTranslations('Agents');
  const locale = useLocale();
  const { hasPermission, user } = useAuth();
  const canCreate = hasPermission('users.create');
  const canSeeToday = hasPermission('reports.read');
  const canDelete = hasPermission('users.delete');

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data, isLoading, isError, error, refetch, isFetching } = useUsersQuery({
    roleCode: 'SALES_AGENT',
    page,
    pageSize: 25,
    search: debouncedSearch || undefined,
  });

  const { data: dashboard } = useDashboardQuery(canSeeToday);
  const todayByAgentId = useMemo(() => {
    const map = new Map<string, NonNullable<typeof dashboard>['agentsToday'][number]>();
    dashboard?.agentsToday.forEach((row) => map.set(row.agentId, row));
    return map;
  }, [dashboard]);

  const hasFilters = debouncedSearch.length > 0;

  function handleExport() {
    if (!data) return;
    exportToCsv(`agentlar-${new Date().toISOString().slice(0, 10)}.csv`, data.data, [
      { header: t('name'), value: (a) => `${a.firstName} ${a.lastName}` },
      { header: t('phone'), value: (a) => a.phone },
    ]);
  }

  const deleteMutation = useDeleteUserMutation();
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync({ id: pendingDelete.id });
      toast.success(t('deleteSuccess', { name: `${pendingDelete.firstName} ${pendingDelete.lastName}` }));
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(errorMessage(err, locale));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {canCreate && (
          <Link href="/users/new" className={buttonVariants({})}>
            <Plus className="mr-2 h-4 w-4" />
            {t('newAgent')}
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t('searchPlaceholder')}
            className="pl-9"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
          {t('refresh')}
        </Button>

        <ExportCsvButton onExport={handleExport} disabled={!data || data.data.length === 0} />
      </div>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 py-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      )}

      {isError && !isLoading && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{errorMessage(error, locale)}</span>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {data && data.data.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <UserCog className="h-10 w-10 text-muted-foreground" />
            {hasFilters ? (
              <p className="text-sm text-muted-foreground">{t('emptySearch')}</p>
            ) : (
              <>
                <p className="max-w-sm text-sm text-muted-foreground">{t('emptyState')}</p>
                {canCreate && (
                  <Link href="/users/new" className={buttonVariants({ size: 'sm' })}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('newAgent')}
                  </Link>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <AgentsTable
              agents={data.data}
              todayByAgentId={todayByAgentId}
              showToday={canSeeToday}
              canDelete={canDelete}
              currentUserId={user?.id}
              onDelete={(agent) => {
                setDeleteError(null);
                setPendingDelete(agent);
              }}
            />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        itemName={pendingDelete ? `${pendingDelete.firstName} ${pendingDelete.lastName}` : ''}
        error={deleteError}
        isPending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
