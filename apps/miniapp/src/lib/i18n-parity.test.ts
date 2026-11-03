import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import uz from '../../messages/uz.json';
import ru from '../../messages/ru.json';
import en from '../../messages/en.json';

// vitest cwd = apps/miniapp; import.meta.url is not a file: URL under jsdom
const APPS = resolve(process.cwd(), '..');
const LOCALES = ['uz', 'ru', 'en'] as const;
// ADR-046: user-facing "faktura"/"счёт-фактура"/"tax invoice" is replaced by "Ichki hisob"/"Внутренний счёт"/"Internal invoice".
const FORBIDDEN_TERMS = /faktur|фактур|счет-фактур|счёт-фактур|tax invoice/i;
// Exception list: intentionally empty — no file may keep these terms. Add entries here only with a justifying comment.
const TERM_ALLOWLIST: string[] = [];

function flatten(node: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, key));
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : String(v);
  }
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('key-tree parity uz/ru/en (web + miniapp)', () => {
  for (const app of ['web', 'miniapp'] as const) {
    const trees = Object.fromEntries(
      LOCALES.map((l) => [l, flatten(JSON.parse(readFileSync(join(APPS, app, 'messages', `${l}.json`), 'utf8')))]),
    );
    it(`${app}: identical key sets and no empty values`, () => {
      const base = Object.keys(trees.uz).sort();
      expect(Object.keys(trees.ru).sort()).toEqual(base);
      expect(Object.keys(trees.en).sort()).toEqual(base);
      for (const l of LOCALES) {
        const empty = Object.entries(trees[l]).filter(([, v]) => v.trim() === '').map(([k]) => `${l}.${k}`);
        expect(empty).toEqual([]);
      }
    });
  }
});

describe('ADR-046 internal-invoice wording guard', () => {
  it('no faktura / счёт-фактура / tax invoice in web/miniapp messages or API source', () => {
    const files = [
      ...LOCALES.flatMap((l) => [join(APPS, 'web/messages', `${l}.json`), join(APPS, 'miniapp/messages', `${l}.json`)]),
      ...walkTs(join(APPS, 'api/src')),
    ].filter((f) => !TERM_ALLOWLIST.some((a) => f.endsWith(a)));
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (FORBIDDEN_TERMS.test(line)) hits.push(`${f}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

const HANDOVER_KEYS = {
  Payment: ['handoverNotice', 'debtNotReducedNote', 'inTransit'],
  Queue: ['handoverPending', 'handoverPosted', 'handoverRejected', 'handoverPendingNote', 'handoverRejectedNote'],
} as const;

describe('ADR-029 handover translations', () => {
  for (const [name, m] of Object.entries({ uz, ru, en })) {
    it(`${name} has every handover key, non-empty`, () => {
      const msgs = m as unknown as Record<string, Record<string, string>>;
      for (const [ns, keys] of Object.entries(HANDOVER_KEYS)) {
        for (const k of keys) expect(msgs[ns]?.[k], `${name}.${ns}.${k}`).toBeTruthy();
      }
    });
  }
});
