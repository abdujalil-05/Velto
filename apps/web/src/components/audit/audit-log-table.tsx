'use client';

import { Fragment, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import type { AuditLogEntry } from '@/lib/api/audit';

export function AuditLogTable({ entries }: { entries: AuditLogEntry[] }) {
  const t = useTranslations('Audit');
  const locale = useLocale();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="w-8 pb-2" />
            <th className="pb-2 pr-3 font-medium">{t('date')}</th>
            <th className="pb-2 pr-3 font-medium">{t('user')}</th>
            <th className="pb-2 pr-3 font-medium">{t('action')}</th>
            <th className="pb-2 font-medium">{t('entity')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map((entry) => {
            const expanded = expandedId === entry.id;
            const hasDetails = entry.oldValue !== null || entry.newValue !== null;
            return (
              <Fragment key={entry.id}>
                <tr
                  className={hasDetails ? 'cursor-pointer hover:bg-accent/50' : undefined}
                  onClick={() => hasDetails && setExpandedId(expanded ? null : entry.id)}
                >
                  <td className="py-2 text-muted-foreground">
                    {hasDetails && (expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />)}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{formatDateTime(entry.createdAt, locale)}</td>
                  <td className="py-2 pr-3">{entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : t('system')}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{entry.action}</td>
                  <td className="py-2 text-muted-foreground">
                    {entry.entity} <span className="font-mono text-xs">#{entry.entityId.slice(0, 8)}</span>
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={5} className="bg-muted/30 px-3 py-3">
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div>
                          <p className="mb-1 text-xs font-medium text-muted-foreground">{t('before')}</p>
                          <pre className="max-h-48 overflow-auto rounded bg-card p-2 text-xs">
                            {entry.oldValue ? JSON.stringify(entry.oldValue, null, 2) : '—'}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 text-xs font-medium text-muted-foreground">{t('after')}</p>
                          <pre className="max-h-48 overflow-auto rounded bg-card p-2 text-xs">
                            {entry.newValue ? JSON.stringify(entry.newValue, null, 2) : '—'}
                          </pre>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
