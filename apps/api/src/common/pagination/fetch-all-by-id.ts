const PAGE_SIZE = 100;

/** Drains a systemPrisma query page by page (id-ascending cursor) so a fixed `take` never starves rows beyond the first page. */
export async function fetchAllById<T extends { id: string }>(fetchPage: (args: { take: number; cursor?: { id: string }; skip?: number }) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let cursor: string | undefined; ; ) {
    const batch = await fetchPage({ take: PAGE_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    cursor = batch[batch.length - 1]!.id;
  }
  return all;
}
