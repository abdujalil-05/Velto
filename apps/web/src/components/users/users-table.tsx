'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Pencil, Power } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import type { User } from '@/lib/api/users';

interface UsersTableProps {
  users: User[];
  canUpdate: boolean;
  currentUserId?: string;
  onEdit: (user: User) => void;
  onToggleActive: (user: User) => void;
  togglingId?: string;
}

export function UsersTable({ users, canUpdate, currentUserId, onEdit, onToggleActive, togglingId }: UsersTableProps) {
  const t = useTranslations('Users');
  const tRoles = useTranslations('AppShell.roles');
  const locale = useLocale();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('name')}</th>
            <th className="pb-2 pr-3 font-medium">{t('phone')}</th>
            <th className="pb-2 pr-3 font-medium">{t('roles')}</th>
            <th className="pb-2 pr-3 font-medium">{t('lastLogin')}</th>
            <th className="pb-2 pr-3 font-medium">{t('status')}</th>
            {canUpdate && <th className="pb-2 text-right font-medium">{t('actions')}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {users.map((user) => (
            <tr key={user.id} className="hover:bg-accent/50">
              <td className="py-2 pr-3 font-medium">
                {user.firstName} {user.lastName}
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{user.phone}</td>
              <td className="py-2 pr-3">
                <div className="flex flex-wrap gap-1">
                  {user.roles.map((role) => (
                    <Badge key={role.id} variant="outline">
                      {tRoles(role.code)}
                    </Badge>
                  ))}
                </div>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">
                {user.lastLoginAt ? formatDateTime(user.lastLoginAt, locale) : '—'}
              </td>
              <td className="py-2 pr-3">
                <Badge variant={user.isActive ? 'success' : 'outline'}>
                  {user.isActive ? t('active') : t('inactive')}
                </Badge>
              </td>
              {canUpdate && (
                <td className="py-2 text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onEdit(user)} aria-label={t('edit')}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onToggleActive(user)}
                      disabled={togglingId === user.id || user.id === currentUserId}
                      aria-label={user.isActive ? t('deactivate') : t('activate')}
                      title={user.id === currentUserId ? t('cannotDeactivateSelf') : undefined}
                    >
                      <Power className={user.isActive ? 'h-4 w-4 text-destructive' : 'h-4 w-4 text-success'} />
                    </Button>
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
