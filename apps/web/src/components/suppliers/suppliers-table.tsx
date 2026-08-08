'use client';

import { useTranslations } from 'next-intl';
import { Pencil, Power } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SortableHeader } from '@/components/shared/sortable-header';
import type { SortState } from '@/lib/hooks/use-sort';
import type { Supplier } from '@/lib/api/suppliers';

interface SuppliersTableProps {
  suppliers: Supplier[];
  canUpdate: boolean;
  onEdit: (supplier: Supplier) => void;
  onToggleActive: (supplier: Supplier) => void;
  togglingId?: string;
  sort: SortState;
  onSort: (column: string) => void;
}

export function SuppliersTable({ suppliers, canUpdate, onEdit, onToggleActive, togglingId, sort, onSort }: SuppliersTableProps) {
  const t = useTranslations('Suppliers');

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
            <th className="pb-2 pr-3 font-medium">{t('status')}</th>
            {canUpdate && <th className="pb-2 text-right font-medium">{t('actions')}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {suppliers.map((supplier) => (
            <tr key={supplier.id} className="hover:bg-accent/50">
              <td className="py-2 pr-3 font-medium">{supplier.name}</td>
              <td className="py-2 pr-3 text-muted-foreground">{supplier.phone || '—'}</td>
              <td className="py-2 pr-3 text-muted-foreground">{supplier.address || '—'}</td>
              <td className="py-2 pr-3">
                <Badge variant={supplier.isActive ? 'success' : 'outline'}>
                  {supplier.isActive ? t('active') : t('inactive')}
                </Badge>
              </td>
              {canUpdate && (
                <td className="py-2 text-right">
                  <div className="flex justify-end gap-1">
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
