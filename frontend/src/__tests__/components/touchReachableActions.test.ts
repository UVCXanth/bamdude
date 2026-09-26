/**
 * Card and row actions stay reachable without a hover-capable pointer (upstream #2865).
 *
 * Tailwind v4 compiles `hover:` and `group-hover:` inside `@media (hover: hover)`,
 * so on a touch-only device the reveal rule is never applied at all: a control
 * written as `opacity-0 group-hover:opacity-100` is invisible for good. A
 * viewport-width check (`isMobile ? 'opacity-100' : …`) covered a phone and
 * missed an iPad in landscape, which is touch-only at 1024px.
 *
 * The fix gates the HIDING half on the `can-hover` variant (`index.css`), so
 * with no hover-capable pointer the control keeps its own opacity. jsdom does not
 * evaluate media queries, so this pins the class contract across the tree: an
 * unprefixed `opacity-0` beside a `group-hover…:opacity-100` reveal is the
 * defect, because it applies unconditionally while its undoing does not.
 *
 * A decorative reveal — nothing is unreachable, only unseen — is listed below
 * with its reason. Anything that can be clicked does not belong on that list.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const indexCss = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');

const sources = import.meta.glob(['../../**/*.tsx', '!../../__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** `opacity-0` with no variant in front of it, beside a group-hover reveal. */
const BARE_HIDE = /(?<![\w:/-])opacity-0(?![\w-])/;
const HOVER_REVEAL = /group-hover(\/[\w-]+)?:opacity-100/;

/** [file suffix, a snippet of the line, why hover-only is fine there]. */
const DECORATIVE: ReadonlyArray<[string, string, string]> = [
  ['components/spool-form/ColorSection.tsx', 'whitespace-nowrap', 'swatch name tooltip'],
  ['pages/ArchivesPage.tsx', 'font-mono', 'content-hash badge'],
  ['components/PlateObjectsPreviewModal.tsx', 'bg-black/60 rounded', 'enlarge hint; the image itself opens it'],
  ['components/SkipObjectsModal.tsx', 'bg-black/60 rounded', 'enlarge hint; the image itself opens it'],
  ['pages/FileManagerPage.tsx', 'group-hover/resize', 'resize grip dots; the handle itself is the control'],
];

function offenders(): string[] {
  const found: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    source.split('\n').forEach((line, index) => {
      if (!BARE_HIDE.test(line) || !HOVER_REVEAL.test(line)) return;
      const decorative = DECORATIVE.some(([file, snippet]) => path.endsWith(file) && line.includes(snippet));
      if (!decorative) found.push(`${path.replace('../../', '')}:${index + 1}`);
    });
  }
  return found;
}

describe('hover-revealed controls on a touch-only device', () => {
  it('declares the can-hover variant the hiding half hangs on', () => {
    expect(indexCss).toMatch(/@custom-variant can-hover \(@media \(hover: hover\) and \(pointer: fine\)\)/);
  });

  it('never hides a control unconditionally behind a hover reveal', () => {
    expect(offenders()).toEqual([]);
  });

  it('lists only decorative reveals as exempt, each still present', () => {
    // A stale entry would quietly exempt whatever lands on that line next.
    for (const [file, snippet] of DECORATIVE) {
      const entry = Object.entries(sources).find(([path]) => path.endsWith(file));
      expect(entry, file).toBeDefined();
      const lines = entry![1].split('\n');
      expect(
        lines.some((line) => line.includes(snippet) && BARE_HIDE.test(line) && HOVER_REVEAL.test(line)),
        `${file}: ${snippet}`,
      ).toBe(true);
    }
  });
});
