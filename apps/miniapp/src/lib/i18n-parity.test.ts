import { describe, expect, it } from 'vitest';
import uz from '../../messages/uz.json';
import ru from '../../messages/ru.json';
import en from '../../messages/en.json';

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
