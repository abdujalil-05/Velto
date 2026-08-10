'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { useUsersQuery } from '@/lib/api/users';
import { useCouriersQuery, courierName } from '@/lib/api/couriers';
import type { RouteInput } from '@/lib/api/routes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { RouteStopEditor, type RouteStopDraft } from './route-stop-editor';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
type AssigneeType = 'agent' | 'courier';

export interface RouteFormDefaults {
  agentId?: string;
  courierId?: string;
  weekday?: number;
  name?: string;
  stops?: RouteStopDraft[];
}

interface RouteFormProps {
  mode: 'create' | 'edit';
  defaultValues?: RouteFormDefaults;
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: RouteInput) => void;
}

export function RouteForm({ mode, defaultValues, isSubmitting, submitError, onSubmit }: RouteFormProps) {
  const t = useTranslations('Routes.form');
  const tWeekday = useTranslations('Routes');

  const { data: agents, isLoading: agentsLoading } = useUsersQuery({ roleCode: 'SALES_AGENT', isActive: true, pageSize: 100 });
  const { data: couriers, isLoading: couriersLoading } = useCouriersQuery({ pageSize: 100, isActive: true });

  const [assigneeType, setAssigneeType] = useState<AssigneeType>(defaultValues?.courierId ? 'courier' : 'agent');
  const [agentId, setAgentId] = useState(defaultValues?.agentId ?? '');
  const [courierId, setCourierId] = useState(defaultValues?.courierId ?? '');
  const [weekday, setWeekday] = useState(defaultValues?.weekday ?? 1);
  const [name, setName] = useState(defaultValues?.name ?? '');
  const [stops, setStops] = useState<RouteStopDraft[]>(defaultValues?.stops ?? []);
  const [validationError, setValidationError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (assigneeType === 'agent' && !agentId) {
      setValidationError(t('selectAgentFirst'));
      return;
    }
    if (assigneeType === 'courier' && !courierId) {
      setValidationError(t('selectCourierFirst'));
      return;
    }
    if (!name.trim()) {
      setValidationError(t('nameRequired'));
      return;
    }
    if (stops.length === 0) {
      setValidationError(t('emptyStopsError'));
      return;
    }

    onSubmit({
      agentId: assigneeType === 'agent' ? agentId : undefined,
      courierId: assigneeType === 'courier' ? courierId : undefined,
      weekday,
      name: name.trim(),
      stops: stops.map((s) => ({ outletId: s.outletId })),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label>{t('assigneeType')}</Label>
        <div className="flex gap-1 rounded-md border border-border p-1 sm:w-fit">
          {(['agent', 'courier'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setAssigneeType(type)}
              className={cn(
                'whitespace-nowrap rounded px-3 py-1 text-sm font-medium transition-colors',
                assigneeType === type ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {t(type === 'agent' ? 'assigneeTypeAgent' : 'assigneeTypeCourier')}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {assigneeType === 'agent' ? (
          <div className="space-y-2">
            <Label htmlFor="agentId">{t('agent')}</Label>
            <Select id="agentId" value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={agentsLoading}>
              <option value="">—</option>
              {agents?.data.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.firstName} {agent.lastName}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="courierId">{t('courier')}</Label>
            <Select id="courierId" value={courierId} onChange={(e) => setCourierId(e.target.value)} disabled={couriersLoading}>
              <option value="">—</option>
              {couriers?.data.map((courier) => (
                <option key={courier.id} value={courier.id}>
                  {courierName(courier)}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="weekday">{t('weekday')}</Label>
          <Select id="weekday" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
            {WEEKDAYS.map((day) => (
              <option key={day} value={day}>
                {tWeekday(`weekdays.${day}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">{t('name')}</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t('stops')}</Label>
        <RouteStopEditor stops={stops} onChange={setStops} />
      </div>

      {(validationError || submitError) && (
        <Alert variant="destructive">
          <AlertDescription>{validationError ?? submitError}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" size="lg" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t(mode === 'create' ? 'submitCreate' : 'submitUpdate')}
      </Button>
    </form>
  );
}
