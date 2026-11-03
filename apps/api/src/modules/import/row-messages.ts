import type { RowError, RowMessage } from './import.constants';

type Rule = [RegExp, (m: RegExpMatchArray) => RowMessage];

// Parsers emit uz text; this maps each known message to ru/en so the preview
// and result reports are trilingual (TZ error contract) without touching the
// parsers. Unknown text falls back to the uz string in all three languages.
const RULES: Rule[] = [
  [/^(\w+) majburiy$/, (m) => ({ uz: m[0], ru: `${m[1]}: обязательное поле`, en: `${m[1]} is required` })],
  [
    /^(\w+) (\d+) belgidan oshmasligi kerak$/,
    (m) => ({ uz: m[0], ru: `${m[1]}: не более ${m[2]} символов`, en: `${m[1]} must not exceed ${m[2]} characters` }),
  ],
  [
    /^(\w+) "(.*)" faylda takrorlangan$/,
    (m) => ({ uz: m[0], ru: `${m[1]} "${m[2]}" повторяется в файле`, en: `${m[1]} "${m[2]}" is duplicated in the file` }),
  ],
  [
    /^(\w+) "(.*)" allaqachon mavjud$/,
    (m) => ({
      uz: m[0],
      ru: `${m[1]} "${m[2]}" уже существует (импорт только создаёт, строка пропущена)`,
      en: `${m[1]} "${m[2]}" already exists (import is create-only, row skipped)`,
    }),
  ],
  [
    /^paymentTermDays /,
    (m) => ({ uz: m.input!, ru: 'paymentTermDays: неотрицательное целое число', en: 'paymentTermDays must be a non-negative integer' }),
  ],
  [
    /^outletLatitude va outletLongitude /,
    (m) => ({ uz: m.input!, ru: 'outletLatitude и outletLongitude должны быть указаны вместе', en: 'outletLatitude and outletLongitude must both be provided' }),
  ],
  [/^outletLatitude -90/, (m) => ({ uz: m.input!, ru: 'outletLatitude: диапазон -90..90', en: 'outletLatitude must be within -90..90' })],
  [/^outletLongitude -180/, (m) => ({ uz: m.input!, ru: 'outletLongitude: диапазон -180..180', en: 'outletLongitude must be within -180..180' })],
  [/^vatRate 0/, (m) => ({ uz: m.input!, ru: 'vatRate: диапазон 0..100', en: 'vatRate must be within 0..100' })],
  [/^minPrice /, (m) => ({ uz: m.input!, ru: 'minPrice: неотрицательное число', en: 'minPrice must be a non-negative number' })],
];

export function translateRowMessage(uz: string): RowMessage {
  for (const [re, build] of RULES) {
    const m = uz.match(re);
    if (m) return build(m);
  }
  return { uz, ru: uz, en: uz };
}

export function localizeRowErrors(errors: RowError[]): RowError[] {
  return errors.map((e) => ({ ...e, i18n: e.messages.map(translateRowMessage) }));
}
