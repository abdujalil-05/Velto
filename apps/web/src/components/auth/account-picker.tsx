'use client';

import { useId } from 'react';
import type { CompanyChoice } from '@/lib/api/auth';

interface AccountPickerProps {
  legend: string;
  options: CompanyChoice[];
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}

/** Native radio group: arrow-key navigation and screen-reader semantics come for free. */
export function AccountPicker({ legend, options, value, onChange, disabled }: AccountPickerProps) {
  const name = useId();
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      {options.map((o) => (
        <label
          key={o.id}
          className="flex min-h-12 cursor-pointer items-center gap-3 rounded-md border border-input px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
        >
          <input
            type="radio"
            name={name}
            value={o.id}
            checked={value === o.id}
            onChange={() => onChange(o.id)}
            className="h-4 w-4 accent-primary"
          />
          <span>{o.name}</span>
        </label>
      ))}
    </fieldset>
  );
}
