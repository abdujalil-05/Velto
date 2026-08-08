'use client';

import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const STEP_KEYS = ['company', 'warehouse', 'product', 'customer', 'agent'] as const;

interface StepIndicatorProps {
  currentIndex: number;
  completed: Set<number>;
  onSelect: (index: number) => void;
}

export function StepIndicator({ currentIndex, completed, onSelect }: StepIndicatorProps) {
  const t = useTranslations('Onboarding.steps');

  return (
    <ol className="flex flex-wrap items-center gap-2">
      {STEP_KEYS.map((key, index) => {
        const isDone = completed.has(index);
        const isCurrent = index === currentIndex;
        return (
          <li key={key}>
            <button
              type="button"
              onClick={() => onSelect(index)}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                isCurrent
                  ? 'border-primary bg-primary text-primary-foreground'
                  : isDone
                    ? 'border-success/40 bg-success/10 text-success'
                    : 'border-border text-muted-foreground hover:bg-accent',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full text-xs',
                  isCurrent ? 'bg-primary-foreground/20' : isDone ? 'bg-success/20' : 'bg-muted',
                )}
              >
                {isDone ? <Check className="h-3 w-3" /> : index + 1}
              </span>
              {t(key)}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
