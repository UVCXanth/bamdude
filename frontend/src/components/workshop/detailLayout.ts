/**
 * The two columns of a Workshop detail page — the product's (WS-13 E9 B05) and the
 * customer's (E11 E02), the mockup's `.w-product-layout` / `.w-customer-layout`: the side
 * panel and the main one, 16 apart, aligned to the top; ≤ 1100 a 240 px side; ≤ 760 one
 * column with the side panel ABOVE the main one. The page is never wider than the screen.
 * ⚠️ `max-[1101px]`: Tailwind 4 writes `max-*` as `width < N`.
 */
export const DETAIL_COLUMNS =
  'grid items-start gap-4 grid-cols-[clamp(260px,17vw,360px)_minmax(0,1fr)] max-[1101px]:grid-cols-[240px_minmax(0,1fr)] max-[761px]:grid-cols-1';
