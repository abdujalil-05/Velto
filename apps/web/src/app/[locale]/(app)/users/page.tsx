'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, RefreshCw, Search, Users as UsersIcon } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import {
  useUsersQuery,
  useActivateUserMutation,
  useDeactivateUserMutation,
  useDeleteUserMutation,
  type User,
  type UserReferences,
} from '@/lib/api/users';
import { ApiError, errorMessage } from '@/lib/api/client';
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

type StatusFilter = 'all' | 'active' | 'inactive';

/** Order the reference counters are listed in — mirrors `Users.references.*`. */
const REFERENCE_KEYS = [
  'salesOrders',
  'payments',
  'cashSessions',
  'routes',
  'visits',
  'purchaseOrders',
  'auditLogs',
  'exportJobs',
  'notifications',
] as const satisfies readonly (keyof UserReferences)[];

/** `details.references` only rides along on the 409 a `hard=true` delete throws. */
function referencesFromError(error: unknown): UserReferences | null {
  if (!(error instanceof ApiError)) return null;
  const details = error.details as { references?: UserReferences } | undefined;
  return details?.references ?? null;
}

export default function UsersPage() {
  const t = useTranslations('Users');
  const tRoles = useTranslations('AppShell.roles');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const { hasPermission, user: currentUser } = useAuth();
  const canCreate = hasPermission('users.create');
  const canUpdate = hasPermission('users.update');
  const canDelete = hasPermission('users.delete');
  const router = useRouter();

  /** "Sales orders: 3, Payments: 2" — the human-readable side of `references`. */
  function formatReferences(references: UserReferences): string {
    return REFERENCE_KEYS.filter((key) => (references[key] ?? 0) > 0)
      .map((key) => `${t(`references.${key}`)}: ${references[key]}`)
      .join(', ');
  }

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
  const [pendingDeactivate, setPendingDeactivate] = useState<User | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);
  const deleteMutation = useDeleteUserMutation();
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Deactivation cuts the user off from the system — always confirm.
  // Re-activation is harmless, so it fires straight away.
  async function toggleActive(targetUser: User) {
    if (targetUser.isActive) {
      setPendingDeactivate(targetUser);
      return;
    }
    setTogglingId(targetUser.id);
    try {
      await activateMutation.mutateAsync(targetUser.id);
    } catch (err) {
      toast.error(errorMessage(err, locale));
    } finally {
      setTogglingId(undefined);
    }
  }

  async function confirmDeactivate() {
    if (!pendingDeactivate) return;
    setDeactivateError(null);
    setTogglingId(pendingDeactivate.id);
    try {
      await deactivateMutation.mutateAsync(pendingDeactivate.id);
      setPendingDeactivate(null);
    } catch (err) {
      setDeactivateError(errorMessage(err, locale));
    } finally {
      setTogglingId(undefined);
    }
  }

  // Deleting is a different operation from deactivating: it revokes every role,
  // kills live sessions and then either anonymizes the account (if history
  // points at it) or drops the row. The API decides which and reports it back
  // as `mode` — we only learn the outcome after the fact, so the confirmation
  // text has to describe both branches.
  async function confirmDelete() {
    if (!pendingDelete) return;
    const name = `${pendingDelete.firstName} ${pendingDelete.lastName}`;
    setDeleteError(null);
    try {
      const result = await deleteMutation.mutateAsync({ id: pendingDelete.id });
      setPendingDelete(null);
      if (result.mode === 'soft') {
        const summary = formatReferences(result.references);
        toast.success(summary ? t('deleteSoftSuccessWithRefs', { name, items: summary }) : t('deleteSoftSuccess', { name }));
      } else {
        toast.success(t('deleteHardSuccess', { name }));
      }
    } catch (err) {
      // A 409 from a `hard` delete carries the blocking row counts — spell them
      // out instead of leaving the user with a bare "conflict".
      const references = referencesFromError(err);
      const summary = references ? formatReferences(references) : '';
      setDeleteError(
        summary ? `${errorMessage(err, locale)} ${t('deleteBlockedBy', { items: summary })}` : errorMessage(err, locale),
      );
    }
  }

  const hasFilters = debouncedSearch.length > 0 || filter !== 'all';

  function handleExport() {
    if (!data) return;
    exportToCsv(`foydalanuvchilar-${new Date().toISOString().slice(0, 10)}.csv`, data.data, [
      { header: t('name'), value: (u) => `${u.firstName} ${u.lastName}` },
      { header: t('phone'), value: (u) => u.phone },
      { header: t('roles'), value: (u) => u.roles.map((r) => tRoles(r.code)).join('; ') },
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
              canDelete={canDelete}
              currentUserId={currentUser?.id}
              onEdit={(u) => router.push(`/users/${u.id}/edit`)}
              onToggleActive={toggleActive}
              onDelete={(u) => {
                setDeleteError(null);
                setPendingDelete(u);
              }}
              togglingId={togglingId}
            />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={pendingDeactivate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeactivate(null);
            setDeactivateError(null);
          }
        }}
        title={tCommon('confirmDeactivate.title')}
        description={tCommon('confirmDeactivate.description', {
          name: pendingDeactivate ? `${pendingDeactivate.firstName} ${pendingDeactivate.lastName}` : '',
        })}
        confirmLabel={tCommon('confirmDeactivate.confirm')}
        error={deactivateError}
        isPending={deactivateMutation.isPending}
        onConfirm={confirmDeactivate}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        title={t('confirmDelete.title')}
        description={t('confirmDelete.description', {
          name: pendingDelete ? `${pendingDelete.firstName} ${pendingDelete.lastName}` : '',
        })}
        confirmLabel={t('delete')}
        error={deleteError}
        isPending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
