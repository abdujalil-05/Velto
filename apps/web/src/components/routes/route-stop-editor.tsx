'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useCustomersQuery, useCustomerOutletsQuery, type Customer } from '@/lib/api/customers';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { SearchSelect } from '@/components/shared/search-select';

export interface RouteStopDraft {
  outletId: string;
  outletName: string;
  customerName: string;
  address: string | null;
}

interface RouteStopEditorProps {
  stops: RouteStopDraft[];
  onChange: (stops: RouteStopDraft[]) => void;
}

export function RouteStopEditor({ stops, onChange }: RouteStopEditorProps) {
  const t = useTranslations('Routes.form');

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const debouncedQuery = useDebouncedValue(customerQuery, 300);
  const { data: customerOptions, isLoading: customersLoading } = useCustomersQuery({
    page: 1,
    pageSize: 10,
    search: debouncedQuery || undefined,
  });
  const { data: outlets, isLoading: outletsLoading } = useCustomerOutletsQuery(customer?.id ?? null);
  const [selectedOutletId, setSelectedOutletId] = useState('');

  function addStop() {
    const outlet = outlets?.find((o) => o.id === selectedOutletId);
    if (!outlet || !customer) return;
    if (stops.some((s) => s.outletId === outlet.id)) return;
    onChange([...stops, { outletId: outlet.id, outletName: outlet.name, customerName: customer.name, address: outlet.address }]);
    setCustomer(null);
    setCustomerQuery('');
    setSelectedOutletId('');
  }

  function removeStop(outletId: string) {
    onChange(stops.filter((s) => s.outletId !== outletId));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= stops.length) return;
    const next = [...stops];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  return (
    <div className="space-y-4">
      {stops.length > 0 && (
        <ol className="divide-y divide-border rounded-md border border-border">
          {stops.map((stop, index) => (
            <li key={stop.outletId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {index + 1}
                </span>
                <div>
                  <p className="font-medium">{stop.outletName}</p>
                  <p className="text-xs text-muted-foreground">
                    {[stop.customerName, stop.address].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={() => move(index, -1)} disabled={index === 0} aria-label={t('moveUp')}>
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => move(index, 1)}
                  disabled={index === stops.length - 1}
                  aria-label={t('moveDown')}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => removeStop(stop.outletId)} aria-label={t('removeStop')}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="space-y-2 rounded-md border border-dashed border-border p-3">
        <p className="text-sm font-medium">{t('addStop')}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <SearchSelect
            selected={customer}
            onSelect={(c) => {
              setCustomer(c);
              setSelectedOutletId('');
            }}
            query={customerQuery}
            onQueryChange={setCustomerQuery}
            items={customerOptions?.data ?? []}
            isLoading={customersLoading}
            getId={(c) => c.id}
            getLabel={(c) => c.name}
            getDescription={(c) => c.code}
            placeholder={t('searchCustomer')}
            emptyText={t('noCustomers')}
          />
          <Select
            value={selectedOutletId}
            onChange={(e) => setSelectedOutletId(e.target.value)}
            disabled={!customer || outletsLoading}
          >
            <option value="">{customer ? (outletsLoading ? t('loadingOutlets') : t('selectOutlet')) : t('selectCustomerFirst')}</option>
            {outlets?.map((outlet) => (
              <option key={outlet.id} value={outlet.id}>
                {outlet.name}
              </option>
            ))}
          </Select>
          <Button type="button" variant="outline" onClick={addStop} disabled={!selectedOutletId}>
            <Plus className="mr-2 h-4 w-4" />
            {t('addStopAction')}
          </Button>
        </div>
      </div>
    </div>
  );
}
