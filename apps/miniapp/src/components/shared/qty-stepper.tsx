'use client';

import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QtyStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}

/** 9.4 Ekran 4 mockup: `− 12 +` — UX-012's ≥48px touch target applies to every control here, not just the buttons, since the number itself is also tappable to type a value directly. */
export function QtyStepper({ value, onChange, min = 0, max, step = 1, className }: QtyStepperProps) {
  // The +/- buttons never step past `max` — but the text input stays
  // unclamped on keystroke so a directly-typed value isn't fought; the
  // caller shows a "reduce quantity" warning instead of silently capping it.
  const clampStep = (n: number) => Math.max(min, max != null ? Math.min(max, n) : n);

  return (
    <div className={cn('inline-flex h-12 items-center rounded-md border border-input', className)}>
      <button
        type="button"
        onClick={() => onChange(clampStep(round(value - step)))}
        disabled={value <= min}
        className="flex h-12 w-12 shrink-0 items-center justify-center text-foreground disabled:opacity-30"
        aria-label="minus"
      >
        <Minus className="h-4 w-4" />
      </button>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? Math.max(min, n) : min);
        }}
        className="h-12 w-14 shrink-0 border-x border-input bg-transparent text-center text-base tabular-nums focus-visible:outline-none"
      />
      <button
        type="button"
        onClick={() => onChange(clampStep(round(value + step)))}
        disabled={max != null && value >= max}
        className="flex h-12 w-12 shrink-0 items-center justify-center text-foreground disabled:opacity-30"
        aria-label="plus"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
