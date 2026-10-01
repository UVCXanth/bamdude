import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WS-13 E7 (final review) — a page-level `sticky` keeps below the app's fixed header.
 *
 * <main> is no scroll box (Layout), so a page's sticky bar sticks to the WINDOW, where
 * the compact header (h-14, below 1144 px) covers the top 56 px. Its offset is the
 * header's height, `--app-top`, which Layout sets. A sticky inside a scroll box of its
 * own — a table head in a `max-h … overflow` box, a menu, a panel — sticks to that box
 * and keeps `top-0`: those files are listed with the box they live in.
 */
const SRC = join(process.cwd(), 'src');
const OWN_SCROLL_BOX: Record<string, string> = {
  'components/BugReportBubble.tsx': 'the bubble panel scrolls',
  'components/ColorCatalogSettings.tsx': 'thead in a max-h overflow box',
  'components/ContextMenu.tsx': 'inside the menu',
  'components/SpoolCatalogSettings.tsx': 'thead in a max-h overflow box',
  'components/SpoolCsvImportModal.tsx': 'thead in the dialog body',
  'pages/ProfilesPage.tsx': 'thead in an overflow-y-auto box',
};

function sources(dir: string): string[] {
  return readdirSync(join(SRC, dir)).flatMap((name) => {
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(SRC, rel)).isDirectory()) return name === '__tests__' ? [] : sources(rel);
    return name.endsWith('.tsx') ? [rel] : [];
  });
}

describe('page-level sticky', () => {
  it('keeps below the fixed app header through --app-top', () => {
    const offenders = sources('')
      .filter((rel) => !(rel in OWN_SCROLL_BOX))
      .flatMap((rel) =>
        readFileSync(join(SRC, rel), 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${rel}:${i + 1}` }))
          .filter(({ line }) => line.split(/[\s'"`{}]+/).some((t) => /(^|:)sticky$/.test(t)))
          .flatMap(({ line, at }) =>
            line
              .split(/[\s'"`{}]+/)
              .filter((t) => /(^|:)top-/.test(t) && !t.includes('--app-top'))
              .map((t) => `${at} ${t}`),
          ),
      );
    expect(offenders).toEqual([]);
  });

  it('gives the document the same offset as its scroll padding', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    expect(css).toMatch(/scroll-padding-top:\s*var\(--app-top/);
  });
});
