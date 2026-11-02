import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertJsonSourceSupport } from './json-number-guard';

describe('assertJsonSourceSupport', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes on a runtime that supplies context.source', () => {
    expect(() => assertJsonSourceSupport()).not.toThrow();
  });

  it('throws when JSON.parse reviver gets no context.source', () => {
    vi.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: (k: string, v: unknown) => unknown) => {
      const v = Number(text);
      return reviver ? reviver('', v) : v;
    }) as typeof JSON.parse);
    expect(() => assertJsonSourceSupport()).toThrow(/source-text access unavailable/);
  });
});
