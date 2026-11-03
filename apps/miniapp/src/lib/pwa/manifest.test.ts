import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest } from './manifest';

describe('PWA manifest (TZ 8.6)', () => {
  it('has installable standalone fields scoped to the base path', () => {
    const m = buildManifest('/velto/app');
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/velto/app/');
    expect(m.scope).toBe('/velto/app/');
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(buildManifest().start_url).toBe('/');
  });

  it('never references an icon file that is missing from public/', () => {
    for (const i of buildManifest().icons ?? []) {
      expect(existsSync(path.join(__dirname, '../../../public', i.src))).toBe(true);
    }
  });
});
