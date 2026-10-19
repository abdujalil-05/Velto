/**
 * Response shape for ExportJob: never exposes the deprecated `fileUrl` or the object-storage
 * `storageKey` (SEC-001/009 — private files are only reachable via the authenticated /download route).
 */
export function toExportJobView<T extends { fileUrl?: unknown; storageKey?: unknown }>(job: T): Omit<T, 'fileUrl' | 'storageKey'> {
  const { fileUrl: _fileUrl, storageKey: _storageKey, ...rest } = job;
  return rest;
}
