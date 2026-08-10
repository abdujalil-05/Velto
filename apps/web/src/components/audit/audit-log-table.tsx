'use client';

import { useTranslations, useLocale } from 'next-intl';
import { formatDateTime } from '@/lib/format';
import { auditActionMessageKey } from '@/lib/audit-actions';
import type { AuditLogEntry } from '@/lib/api/audit';

export function AuditLogTable({ entries }: { entries: AuditLogEntry[] }) {
  const t = useTranslations('Audit');
  const locale = useLocale();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('date')}</th>
            <th className="pb-2 pr-3 font-medium">{t('user')}</th>
            <th className="pb-2 font-medium">{t('action')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map((entry) => {
            const actionKey = auditActionMessageKey(entry.action);
            const description = actionKey === 'unknown' ? t('actions.unknown', { action: entry.action }) : t(`actions.${actionKey}`);
            return (
              <tr key={entry.id}>
                <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{formatDateTime(entry.createdAt, locale)}</td>
                <td className="py-2 pr-3">{entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : t('system')}</td>
                <td className="py-2">{description}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
