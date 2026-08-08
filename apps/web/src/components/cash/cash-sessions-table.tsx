import { useLocale, useTranslations } from 'next-intl';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import type { CashSession } from '@/lib/api/cash-sessions';

interface CashSessionsTableProps {
  sessions: CashSession[];
}

export function CashSessionsTable({ sessions }: CashSessionsTableProps) {
  const t = useTranslations('Cash');
  const tCommon = useTranslations('Common');
  const locale = useLocale();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('cashier')}</th>
            <th className="pb-2 pr-3 font-medium">{t('openedAt')}</th>
            <th className="pb-2 pr-3 font-medium">{t('closedAt')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('openAmount')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('closeAmount')}</th>
            <th className="pb-2 text-right font-medium">{t('totalCollected')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sessions.map((session) => (
            <tr key={session.id}>
              <td className="py-2 pr-3 font-medium">
                {session.user ? `${session.user.firstName} ${session.user.lastName}` : '—'}
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{formatDateTime(session.openedAt, locale)}</td>
              <td className="py-2 pr-3">
                {session.closedAt ? (
                  <span className="text-muted-foreground">{formatDateTime(session.closedAt, locale)}</span>
                ) : (
                  <Badge variant="warning">{t('open')}</Badge>
                )}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatMoney(session.openAmount)} {tCommon('somUnit')}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {session.closeAmount != null ? `${formatMoney(session.closeAmount)} ${tCommon('somUnit')}` : '—'}
              </td>
              <td className="py-2 text-right font-semibold tabular-nums">
                {formatMoney(session.totalCollected)} {tCommon('somUnit')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
