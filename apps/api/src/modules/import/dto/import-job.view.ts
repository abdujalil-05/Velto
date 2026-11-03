/** Public shape of an ImportJob: the storage location (`fileUrl`) is internal and never leaves the API. */
export function toImportJobView<T extends { fileUrl: string }>(job: T): Omit<T, 'fileUrl'> {
  const { fileUrl: _fileUrl, ...view } = job;
  return view;
}
