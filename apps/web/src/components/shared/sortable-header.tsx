'use client';

import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SortState } from '@/lib/hooks/use-sort';

interface SortableHeaderProps {
  column: string;
  sort: SortState;
  onSort: (column: string) => void;
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

/** 9.1 clickable column header — used in place of a plain `<th>` for sortable columns. */
export function SortableHeader({ column, sort, onSort, children, align = 'left', className }: SortableHeaderProps) {
  const active = sort.sortBy === column;
  const Icon = active ? (sort.sortDir === 'desc' ? ArrowDown : ArrowUp) : ArrowUpDown;

  return (
    <th className={cn('pb-2 pr-3 font-medium', align === 'right' && 'text-right', className)}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
          active && 'text-foreground',
        )}
      >
        {children}
        <Icon className="h-3 w-3 shrink-0" />
      </button>
    </th>
  );
}
