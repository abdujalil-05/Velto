import ExcelJS from 'exceljs';

/** Test-only helper: builds a minimal xlsx buffer from a header row + data rows, for exercising the parsers without going through the real upload template. */
export async function buildTestWorkbook(headers: string[], rows: (string | number | undefined)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
