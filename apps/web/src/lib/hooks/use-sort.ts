import { useState } from 'react';

export type SortDir = 'asc' | 'desc';

export interface SortState {
  sortBy?: string;
  sortDir?: SortDir;
}

/**
 * 9.1 ("har ro'yxatda ... saralash"): click-to-sort state for a table's
 * column headers. First click sorts ascending, second click flips to
 * descending, third click clears back to the list's default order.
 */
export function useSort(initial: SortState = {}) {
  const [sort, setSort] = useState<SortState>(initial);

  function toggle(column: string) {
    setSort((prev) => {
      if (prev.sortBy !== column) return { sortBy: column, sortDir: 'asc' };
      if (prev.sortDir === 'asc') return { sortBy: column, sortDir: 'desc' };
      return {};
    });
  }

  return { sort, toggle };
}
