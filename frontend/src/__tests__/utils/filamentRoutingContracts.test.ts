import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import en from '../../i18n/locales/en';
import uk from '../../i18n/locales/uk';
import { modelCompatibility } from '../../utils/modelCompatibility';

describe('routing mirrors cannot silently drift', () => {
  it.each([['en', en], ['uk', uk]] as const)('keeps %s refusal sentences identical to the backend', (lang, locale) => {
    const backend = JSON.parse(readFileSync(resolve(process.cwd(), `../backend/app/data/filament_routing_${lang}.json`), 'utf8'));
    for (const [code, message] of Object.entries(locale.filamentRouting.feasibility.reason)) {
      expect(message, code).toBe(backend[code]);
    }
    for (const [key, message] of Object.entries(locale.filamentRouting.feasibility.detail)) {
      const backendKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      expect(message.replace(/\{\{([^}]+)\}\}/g, '{$1}'), key).toBe(backend.detail[backendKey]);
    }
  });

  it('uses directed API data and keeps exact matches available before loading', () => {
    const matrix = { P1S: ['P1P'], X1C: ['P1S'] };
    expect(modelCompatibility('C12', 'Bambu Lab P1S')).toBe('exact');
    expect(modelCompatibility('P1P', 'P1S')).toBe('unknown');
    expect(modelCompatibility('P1P', 'P1S', matrix)).toBe('compatible');
    expect(modelCompatibility('P1S', 'P1P', matrix)).toBe('incompatible');
    expect(modelCompatibility('P1P', 'X1C', matrix)).toBe('incompatible');
    expect(modelCompatibility('', 'P1S', matrix)).toBe('unknown');
  });
});
