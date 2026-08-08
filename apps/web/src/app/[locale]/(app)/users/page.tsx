'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, RefreshCw, Search, Users as UsersIcon } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { useUsersQuery, useActivateUserMutation, useDeactivateUserMutation, type User } from '@/lib/api/users';
import { errorMessage } from '@/lib/api/client';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { exportToCsv } from '@/lib/export-csv';
import { formatDateTime } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { ExportCsvButton } from '@/components/shared/export-csv-button';
import { UsersTable } from '@/components/users/users-table';
import { cn } from '@/lib/utils';

type StatusFilter = 'all' | 'active' | 'inactive';

export default function UsersPage() {
  const t = useTranslations('Users');
  const locale = useLocale();
  const { hasPermission, user: currentUser } = useAuth();
  const canCreate = hasPermission('users.create');
  const canUpdate = hasPermission('users.update');
  const router = useRouter();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data, isLoading, isError, error, refetch, isFetching } = useUsersQuery({
    page,
    pageSize: 25,
    search: debouncedSearch || undefined,
    isActive: filter === 'all' ? undefined : filter === 'active',
  });

  const activateMutation = useActivateUserMutation();
  const deactivateMutation = useDeactivateUserMutation();
  const [togglingId, setTogglingId] = useState<string | undefined>();

  async function toggleActive(targetUser: User) {
    setTogglingId(targetUser.id);
    try {
      if (targetUser.isActive) {
        await deactivateMutation.mutateAsync(targetUser.id);
      } else {
        await activateMutation.mutateAsync(targetUser.id);
      }
    } catch (err) {
      toast.error(errorMessage(err, locale));
    } finally {
      setTogglingId(undefined);
    }
  }

  const hasFilters = debouncedSearch.length > 0 || filter !== 'all';

  function handleExport() {
    if (!data) return;
    exportToCsv(`foydalanuvchilar-${new Date().toISOString().slice(0, 10)}.csv`, data.data, [
      { header: t('name'), value: (u) => `${u.firstName} ${u.lastName}` },
      { header: t('phone'), value: (u) => u.phone },
      { header: t('roles'), value: (u) => u.roles.map((r) => r.name).join('; ') },
      { header: t('lastLogin'), value: (u) => (u.lastLoginAt ? formatDateTime(u.lastLoginAt, locale) : '') },
      { header: t('status'), value: (u) => (u.isActive ? t('filter.active') : t('filter.inactive')) },
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {canCreate && (
          <Link href="/users/new" className={buttonVariants({})}>
            <Plus className="mr-2 h-4 w-4" />
            {t('newUser')}
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

        <div className="flex gap-1 rounded-md border border-border p-1">
          {(['all', 'active', 'inactive'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => {
                setFilter(f);
                setPage(1);
              }}
              className={cn(
                'rounded px-3 py-1 text-sm font-medium transition-colors',
                filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {t(`filter.${f}`)}
            </button>
          ))}
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
            <UsersIcon className="h-10 w-10 text-muted-foreground" />
            {hasFilters ? (
              <p className="text-sm text-muted-foreground">{t('emptySearch')}</p>
            ) : (
              <>
                <p className="max-w-sm text-sm text-muted-foreground">{t('emptyState')}</p>
                {canCreate && (
                  <Link href="/users/new" className={buttonVariants({ size: 'sm' })}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('newUser')}
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
            <UsersTable
              users={data.data}
              canUpdate={canUpdate}
              currentUserId={currentUser?.id}
              onEdit={(u) => router.push(`/users/${u.id}/edit`)}
              onToggleActive={toggleActive}
              togglingId={togglingId}
            />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
