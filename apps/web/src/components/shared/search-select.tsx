'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface SearchSelectProps<T> {
  selected: T | null;
  onSelect: (item: T | null) => void;
  query: string;
  onQueryChange: (query: string) => void;
  items: T[];
  isLoading: boolean;
  getId: (item: T) => string;
  getLabel: (item: T) => string;
  getDescription?: (item: T) => string | undefined;
  placeholder: string;
  emptyText: string;
  disabled?: boolean;
}

/** A minimal, dependency-free search-to-select combobox — used wherever a
 * screen needs to pick one record (customer, product, ...) out of a catalog
 * too large to render as a plain <select>. */
export function SearchSelect<T>({
  selected,
  onSelect,
  query,
  onQueryChange,
  items,
  isLoading,
  getId,
  getLabel,
  getDescription,
  placeholder,
  emptyText,
  disabled,
}: SearchSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  if (selected) {
    return (
      <div className="flex h-10 items-center justify-between rounded-md border border-input bg-background px-3">
        <span className="truncate text-sm">{getLabel(selected)}</span>
        {!disabled && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="ml-2 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Clear"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          className="pl-9"
        />
      </div>

      {open && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-card shadow-md">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
          {!isLoading && items.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">{emptyText}</p>}
          {!isLoading &&
            items.map((item) => (
              <button
                key={getId(item)}
                type="button"
                onClick={() => {
                  onSelect(item);
                  setOpen(false);
                }}
                className={cn('flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent')}
              >
                <span className="font-medium">{getLabel(item)}</span>
                {getDescription?.(item) && <span className="text-xs text-muted-foreground">{getDescription(item)}</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
