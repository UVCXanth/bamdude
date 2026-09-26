/**
 * `hover:text-white` follows the theme, like `text-white` does (upstream #1909).
 *
 * `index.css` maps `.text-white` to `--text-primary`, so white text reads on the
 * light themes. Tailwind compiles `hover:text-white` to a different selector,
 * `.hover\:text-white:hover`, which that rule never matched — so the hundreds of
 * `text-bambu-gray hover:text-white` controls turned literally white on hover
 * and vanished against a light background. Both rules sit outside
 * `@layer utilities`, which is what lets them outrank Tailwind's own output.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Comments out first: they mention `@layer` by name.
const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The CSS with every `@layer … { … }` block removed, braces balanced. */
function unlayered(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const at = source.indexOf('@layer', i);
    if (at === -1) return out + source.slice(i);
    out += source.slice(i, at);
    const open = source.indexOf('{', at);
    const semicolon = source.indexOf(';', at);
    if (open === -1 || (semicolon !== -1 && semicolon < open)) {
      i = semicolon + 1; // `@layer a, b;` declaration, no block
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < source.length; j++) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}' && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

describe('white text on the light themes', () => {
  it('maps text-white to the theme text colour, outside any layer', () => {
    expect(unlayered(css)).toMatch(/\.text-white\s*\{\s*color:\s*var\(--text-primary\);?\s*\}/);
  });

  it('does the same for the hover variant', () => {
    expect(unlayered(css)).toMatch(/\.hover\\:text-white:hover\s*\{\s*color:\s*var\(--text-primary\);?\s*\}/);
  });
});
