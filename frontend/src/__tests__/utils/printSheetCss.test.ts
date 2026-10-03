/**
 * The dispatch note prints alone and across as many pages as it needs (spec
 * workshop-dispatch-notes, rule 19; final review I2). jsdom applies no print
 * media, so the rule is pinned by reading it: scoped to a page that carries a
 * sheet, the sheet stays IN FLOW (an absolutely positioned box is not split
 * across pages by every browser), and what is neither the sheet, inside it,
 * nor on its way from <body> is taken out of the layout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');
const block = (() => {
  const start = css.indexOf('@media print');
  expect(start).toBeGreaterThan(-1);
  // The block ends at the first line that is a lone closing brace at column 0.
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
})();

describe('the print sheet rule', () => {
  it('applies only to a page that carries a sheet', () => {
    const selectors = block.match(/^[^{}@\n][^{}]*\{/gm) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector).toContain('body:has([data-print-sheet])');
  });

  it('keeps the sheet in flow, so a long note breaks onto more pages', () => {
    expect(block).not.toMatch(/position:\s*absolute/);
    expect(block).not.toMatch(/visibility:\s*hidden/);
  });

  it('takes everything that is not the sheet, inside it or around it out of the layout', () => {
    expect(block).toMatch(
      /:not\(\[data-print-sheet\]\):not\(\[data-print-sheet\] \*\):not\(:has\(\[data-print-sheet\]\)\)\s*\{\s*display:\s*none/,
    );
  });

  it("repeats the sheet's table header on every page and keeps a row whole (WS-13 E12 J06)", () => {
    expect(block).toMatch(/\[data-print-sheet\] thead\s*\{\s*display:\s*table-header-group/);
    expect(block).toMatch(/\[data-print-sheet\] tr\s*\{\s*break-inside:\s*avoid/);
  });

  it('keeps the parties, the header and the signatures whole (J06)', () => {
    expect(block).toMatch(/\[data-print-sheet\] \[data-print-keep\]\s*\{\s*break-inside:\s*avoid/);
  });

  it('lets the containers around the sheet give up their offsets and scrolling', () => {
    expect(block).toMatch(/:has\(\[data-print-sheet\]\)\s*\{[^}]*margin:\s*0[^}]*overflow:\s*visible/);
  });
});
