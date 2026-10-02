/**
 * `has_cover` is the EFFECTIVE cover — the explicit column or the first picture
 * — so the card never reads `cover_image_filename` to decide. A card that asked
 * the column would show the placeholder for every product whose cover is the
 * implicit first picture, which is most of them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { strayZeroTextNodes } from '../../domHelpers';
import { api, ApiError } from '../../../api/client';
import type { ProductListItem } from '../../../api/client';
import { ProductCard } from '../../../components/products/ProductCard';
import { useProductActions } from '../../../components/products/productActions/useProductActions';
import { PRODUCT_ROW_DEFAULTS } from '../../wireDefaults';

const base: ProductListItem = {
  ...PRODUCT_ROW_DEFAULTS,
  id: 4,
  code: 'PR-0004',
  name: 'Flask',
  is_active: true,
  sku: null,
  version: null,
  category: null,
  status: 'ready',
  origin: 'catalog',
  origin_file_id: null,
  origin_plate_index: null,
  cover_image_filename: null,
  has_cover: false,
  parts_count: 2,
  plates_count: 1,
  lines_count: 0,
  kits_available: 0,
  finished_available: 0,
  materials: [],
  colors: [],
  models: [],
};

// The card's menu runs the page's action host (WS-13 E8 F01) — mounted here as a page would.
function Card({ product }: { product: ProductListItem }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const actions = useProductActions<ProductListItem>({ context: 'catalog', onEdit: () => {}, fallbackFocusRef: heading });
  return (
    <>
      <ProductCard product={product} actions={actions} />
      {actions.host}
    </>
  );
}

function mount(over: Partial<ProductListItem> = {}) {
  render(<Card product={{ ...base, ...over }} />);
}

// WS-13 E8 E: the mockup's vertical card — picture, identity and menu, name and badges,
// composition, models and swatches, and the stock in a footer that lines up across a row.
describe('ProductCard anatomy (WS-13 E8 E01–E04)', () => {
  const full: Partial<ProductListItem> = {
    sku: 'EDU-08',
    version: 'v1.0',
    status: 'draft',
    printed_parts_count: 2,
    plates_count: 2,
    variant_group_names: ['Size'],
    active_orders_count: 3,
    lines_count: 3,
    models: ['P1S'],
    sliced: true,
    colors: ['#1D1D1D'],
    finished_available: 6,
    kits_available: 4,
  };

  it('E01 stacks the parts top to bottom, in the mockup’s order', () => {
    mount(full);
    const card = screen.getByTestId('product-4-card');
    const order = [
      'product-cover-placeholder',
      'product-identity',
      'product-name',
      'product-composition',
      'product-models',
      'product-materials',
      'product-stock',
    ].map((id) => within(card).getByTestId(id));
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(card).getByTestId('product-identity')).toHaveTextContent('PR-0004 · EDU-08 · v1.0');
    expect(within(card).getByTestId('product-name')).toHaveTextContent('Flask');
    expect(within(card).getByText('Draft')).toBeInTheDocument();
    expect(within(card).getByTestId('product-composition')).toHaveTextContent('2 parts · 2 plates · variants: Size');
  });

  it('E01 the picture is a 120 px field across the card, shown whole', () => {
    mount({ has_cover: true });
    const cover = screen.getByTestId('product-cover');
    expect(cover.className).toContain('h-[120px]');
    expect(cover.className).toContain('w-full');
    expect(cover.className).toContain('object-contain');
    expect(cover).toHaveAttribute('src', expect.stringContaining('/products/4/cover-image'));
  });

  it('E01 the footer is the stock, under a rule, pushed to the bottom of the card', () => {
    mount(full);
    const card = screen.getByTestId('product-4-card');
    expect(card.className).toContain('flex-col');
    const footer = within(card).getByTestId('product-stock').closest('[data-part="footer"]') as HTMLElement;
    expect(footer.className).toContain('mt-auto');
    expect(footer.className).toContain('border-t');
    expect(footer).toHaveTextContent('6 finished');
    expect(footer).toHaveTextContent('4 part kits');
  });

  it('E02 the whole card is a link named for the product; the menu and the swatches sit above it', () => {
    mount(full);
    const card = screen.getByTestId('product-4-card');
    expect(within(card).getByRole('link', { name: 'Flask' })).toHaveAttribute('href', '/products/4');
    expect(within(card).getByTestId('product-menu').closest('.z-10')).toBeTruthy();
    expect((within(card).getByTestId('product-materials').querySelector('[data-swatch]') as HTMLElement).className).toContain('z-10');
  });

  it('E03 says nothing about orders or a kits pill — the table and the footer carry them', () => {
    mount(full);
    const card = screen.getByTestId('product-4-card');
    expect(card).not.toHaveTextContent(/in 3 (active )?orders/);
    expect(screen.queryByTestId('product-kits-badge')).not.toBeInTheDocument();
    expect(strayZeroTextNodes(card)).toHaveLength(0);
  });

  it('E04 a long name and a long SKU wrap inside the card', () => {
    mount({ name: 'A'.repeat(120), sku: 'S'.repeat(80) });
    expect(screen.getByTestId('product-name').className).toContain('wrap-anywhere');
    expect(screen.getByTestId('product-identity').className).toContain('wrap-anywhere');
  });

  it('E02 the badges — the «Incomplete» reason in their title — sit above the overlay link', () => {
    mount({ status: 'ready', parts_count: 0 });
    const badge = screen.getByText('Incomplete');
    expect(badge).toHaveAttribute('title');
    expect(badge.closest('.z-10')).toBeTruthy();
  });
});

describe('ProductCard export', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads the product as a ZIP from the card menu', async () => {
    const save = vi.spyOn(api, 'downloadProductExport').mockResolvedValue(undefined);
    mount();

    fireEvent.click(await screen.findByTestId('product-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: /export/i }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(4));
  });

  it('names the trigger as a menu before it is opened', async () => {
    // The popup carries `role="menu"`, but a screen reader meets this button
    // first; without these it is announced as an ordinary button and nothing
    // says a menu opens, or that one is open.
    mount();

    const trigger = await screen.findByTestId('product-menu');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('says so when the export is refused, and stays on the list', async () => {
    vi.spyOn(api, 'downloadProductExport').mockRejectedValue(new ApiError('nope', 500));
    mount();

    fireEvent.click(await screen.findByTestId('product-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: /export/i }));

    expect(await screen.findByText(/export failed \(HTTP 500\)/i)).toBeInTheDocument();
  });
});

/**
 * ⚠️ A `<button>` inside an `<a>` is invalid HTML, and the menu used to be
 * exactly that: every item cancelled the navigation its own click caused, so
 * one item added without the guard navigated instead of acting. The panel now
 * lives on `document.body` and the card's anchor is an overlay.
 */
describe('ProductCard menu placement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the open menu outside the card anchor, on document.body', async () => {
    mount();

    fireEvent.click(await screen.findByTestId('product-menu'));

    const panel = screen.getByRole('menu');
    expect(panel.parentElement).toBe(document.body);
    expect(screen.getByRole('link').contains(panel)).toBe(false);
    expect(screen.getByTestId('product-4-card').querySelector('[role="menu"]')).toBeNull();
  });

  it('closes on Escape', async () => {
    mount();

    fireEvent.click(await screen.findByTestId('product-menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
