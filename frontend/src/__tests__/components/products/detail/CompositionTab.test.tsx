/**
 * The «Composition» tab of the product page (WS-13 E9 D01–D05): the variants card, the
 * read tables of printed and purchased parts with the sources their plates give, and the
 * doors into the existing editors — the edit mode (the existing `CompositionTable`), the
 * row menu, the «Add part» dialog and the «Product variants» dialog. Reading is the
 * default and has no fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useRef, type ReactElement } from 'react';
import { render } from '../../../utils';
import { api, ApiError } from '../../../../api/client';
import type { Permission, Product, ProductPart, ProductSources } from '../../../../api/client';
import { CompositionTab } from '../../../../components/products/detail/CompositionTab';

const auth = vi.hoisted(() => ({ granted: null as Set<string> | null }));
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      return { ...real, hasPermission: (p: Permission) => auth.granted?.has(p) ?? real.hasPermission(p) };
    },
  };
});

function part(over: Partial<ProductPart> & Pick<ProductPart, 'id' | 'name'>): ProductPart {
  return {
    kind: 'printed',
    name_key: over.name.toLowerCase(),
    qty_per_unit: 1,
    aliases: [],
    auto: false,
    unit_price: null,
    sourcing_url: null,
    remarks: null,
    sort_order: over.id,
    ignored: false,
    stock_balance: 0,
    variant_option_id: null,
    ...over,
  };
}

const parts: ProductPart[] = [
  part({ id: 1, name: 'Body', auto: true, aliases: ['body_v2'] }),
  part({ id: 2, name: 'Lid', qty_per_unit: 0, variant_option_id: 11 }),
  part({ id: 3, name: 'Cube', qty_per_unit: 0, ignored: true }),
  part({ id: 4, name: 'Magnet', kind: 'purchased', qty_per_unit: 4, unit_price: 0.5, sourcing_url: 'https://shop.example/m', remarks: 'N52' }),
  part({ id: 5, name: 'Screw', kind: 'purchased', qty_per_unit: 2 }),
];

const product = {
  id: 7,
  code: 'PR-0007',
  name: 'Flask',
  parts,
  parts_count: 5,
  variant_groups: [
    {
      id: 1,
      name: 'Lid type',
      position: 0,
      default_option_id: 10,
      lines_count: 0,
      stock_count: 0,
      parts_count: 1,
      options: [
        { id: 10, name: 'Glass', position: 0, lines_count: 0, parts_count: 0, stock_count: 0 },
        { id: 11, name: 'Cork', position: 1, lines_count: 0, parts_count: 1, stock_count: 0 },
      ],
    },
  ],
} as unknown as Product;

const sources: ProductSources = {
  parts: [
    {
      part_id: 1,
      has_sliced_source: true,
      yield_min: 1,
      yield_max: 2,
      hidden_sources: 1,
      sources: [
        {
          plate_id: 1,
          library_file_id: 30,
          filename: 'body.3mf',
          folder_id: null,
          folder_name: null,
          hidden: false,
          plate_index: 2,
          printer_model: 'X1C',
          sliced: true,
          yield: 2,
          print_time_seconds: 100,
          filament_used_grams: 5,
          recommended: true,
        },
        {
          plate_id: 2,
          library_file_id: 31,
          filename: null,
          folder_id: null,
          folder_name: null,
          hidden: true,
          plate_index: 1,
          printer_model: 'P1S',
          sliced: true,
          yield: 1,
          print_time_seconds: 100,
          filament_used_grams: 5,
          recommended: false,
        },
      ],
    },
    {
      part_id: 2,
      has_sliced_source: false,
      yield_min: null,
      yield_max: null,
      hidden_sources: 0,
      sources: [
        {
          plate_id: 3,
          library_file_id: 32,
          filename: 'lid.stl.3mf',
          folder_id: null,
          folder_name: null,
          hidden: false,
          plate_index: 1,
          printer_model: null,
          sliced: false,
          yield: 1,
          print_time_seconds: null,
          filament_used_grams: null,
          recommended: false,
        },
      ],
    },
    { part_id: 3, has_sliced_source: false, yield_min: null, yield_max: null, hidden_sources: 0, sources: [] },
  ],
};

function Host({ product: p = product }: { product?: Product }) {
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Flask
      </h1>
      <CompositionTab product={p} headingRef={heading} />
    </>
  );
}

const row = (id: number) => screen.getByTestId(`part-${id}-row`);

describe('CompositionTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Granted outright: the helper's own user arrives a tick later than the first render.
    auth.granted = new Set(['projects:read', 'projects:update']);
    vi.spyOn(api, 'getProductSources').mockResolvedValue(sources);
    vi.spyOn(api, 'getSettings').mockResolvedValue({ currency: 'EUR' } as never);
  });

  describe('D01 the variants card', () => {
    it('a row per group: its options in order, the standard marked, the parts each takes', async () => {
      render(<Host />);
      const card = screen.getByTestId('composition-variants');
      expect(within(card).getByText('Lid type')).toBeInTheDocument();
      const chips = within(card).getAllByTestId(/^variant-chip-/);
      expect(chips.map((c) => c.textContent)).toEqual(['Glass · standard no parts', 'Cork Lid']);
      expect(chips[0]).toHaveAttribute('data-standard', 'true');
    });

    it('no groups: every order takes every part', () => {
      render(<Host product={{ ...product, variant_groups: [] }} />);
      expect(screen.getByText('No variants — every order takes all parts.')).toBeInTheDocument();
    });
  });

  describe('D02 printed parts', () => {
    it('reads the table — no fields', async () => {
      render(<Host />);
      expect(within(row(1)).queryByRole('textbox')).not.toBeInTheDocument();
      expect(within(row(1)).getByText('Body')).toBeInTheDocument();
      expect(within(row(1)).getByText('from file')).toBeInTheDocument();
      expect(within(row(1)).getByText('× 1')).toBeInTheDocument();
      expect(within(row(1)).getByText('always')).toBeInTheDocument();
      expect(within(row(1)).getByText('body_v2')).toBeInTheDocument();
      // A zero: out of the kit (a shelf) or not counted (marked) — never an empty cell.
      expect(within(row(2)).getByText('out of kit')).toBeInTheDocument();
      expect(within(row(2)).getByText('Lid type: Cork')).toBeInTheDocument();
      expect(within(row(3)).getByText('not counted')).toBeInTheDocument();
    });

    it('the sources: a model chip and «pl. N · ×Y» each, in the server’s order; a hidden file says so', async () => {
      render(<Host />);
      const cells = await within(row(1)).findAllByTestId('part-source');
      expect(cells).toHaveLength(2);
      expect(cells[0]).toHaveTextContent(/^X1Cpl\. 2 · ×2$/);
      expect(cells[0]).toHaveAttribute('title', 'body.3mf');
      // Drawn the same, without a file name — and it says why.
      expect(cells[1]).toHaveTextContent(/^P1Spl\. 1 · ×1/);
      expect(cells[1]).toHaveAttribute('title', 'in a file you cannot see');
      expect(within(cells[1]).getByText('in a file you cannot see')).toBeInTheDocument();
    });

    it('sources that read alike — same model, plate and yield from several files — are one chip with the count and the files named', async () => {
      // Measured on the stand (WS-13 E9 runner): 39 sliced files gave a part 27 identical chips.
      const same = (plate_id: number, filename: string) => ({
        ...sources.parts[0].sources[0],
        plate_id,
        library_file_id: plate_id,
        filename,
        recommended: plate_id === 21,
      });
      vi.spyOn(api, 'getProductSources').mockResolvedValue({
        parts: [{ ...sources.parts[0], sources: [same(21, 'a.3mf'), same(22, 'b.3mf'), same(23, 'c.3mf'), sources.parts[0].sources[1]] }],
      });
      render(<Host />);
      const cells = await within(row(1)).findAllByTestId('part-source');
      expect(cells).toHaveLength(2);
      expect(cells[0]).toHaveTextContent(/^X1Cpl\. 2 · ×2 · 3 files$/);
      expect(cells[0]).toHaveAttribute('title', 'a.3mf, b.3mf, c.3mf');
      expect(cells[1]).toHaveTextContent(/^P1Spl\. 1 · ×1/);
    });

    it('a source not sliced says so by `sliced`, not by a missing model', async () => {
      render(<Host />);
      const [source] = await within(row(2)).findAllByTestId('part-source');
      expect(source).toHaveTextContent('not sliced');
    });

    it('a part no plate gives: the amber hint', async () => {
      render(<Host />);
      expect(await within(row(3)).findByText('no plate — link or slice a file')).toBeInTheDocument();
    });

    it('sources reading: «…» in the cells; failed: a note with a retry above, the table stays', async () => {
      let fail: (e: Error) => void = () => {};
      vi.spyOn(api, 'getProductSources').mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
      render(<Host />);
      expect(within(row(1)).getByTestId('part-sources')).toHaveTextContent('…');
      await act(async () => fail(new Error('boom')));
      expect(await screen.findByText('Could not load the parts’ plates')).toBeInTheDocument();
      expect(row(1)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await within(row(1)).findAllByTestId('part-source')).toHaveLength(2);
    });

    it('none: says so', () => {
      render(<Host product={{ ...product, parts: parts.filter((p) => p.kind === 'purchased') }} />);
      expect(screen.getByText('No printed parts.')).toBeInTheDocument();
    });
  });

  describe('D03 purchased parts', () => {
    it('price in the farm’s currency, a link to buy in a new tab, remarks; «—» for what is missing', async () => {
      render(<Host />);
      await waitFor(() => expect(within(row(4)).getByTestId('part-price')).toHaveTextContent('€0.50'));
      const link = within(row(4)).getByRole('link', { name: /link/ });
      expect(link).toHaveAttribute('href', 'https://shop.example/m');
      expect(link).toHaveAttribute('target', '_blank');
      expect(within(row(4)).getByText('N52')).toBeInTheDocument();
      expect(within(row(5)).getByTestId('part-price')).toHaveTextContent('—');
      expect(within(row(5)).getByTestId('part-url')).toHaveTextContent('—');
    });

    it('none: says so', () => {
      render(<Host product={{ ...product, parts: parts.filter((p) => p.kind === 'printed') }} />);
      expect(screen.getByText('No purchased parts.')).toBeInTheDocument();
    });
  });

  describe('D04–D05 the doors into the editors', () => {
    it('a reader sees no door at all', () => {
      auth.granted = new Set(['projects:read']);
      render(<Host />);
      expect(screen.queryByRole('button', { name: 'Edit composition' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add part' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Manage variants…' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /actions/i })).not.toBeInTheDocument();
    });

    it('«Edit composition» shows the existing editor; «Done» waits for a save, then reads again', async () => {
      let land: () => void = () => {};
      const update = vi
        .spyOn(api, 'updateProductPart')
        .mockReturnValue(new Promise((resolve) => (land = () => resolve(parts[0] as never))));
      render(<Host />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit composition' }));
      const name = within(row(1)).getByRole('textbox', { name: 'Part' });
      fireEvent.change(name, { target: { value: 'Body 2' } });
      name.focus();
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(update).toHaveBeenCalledWith(7, 1, { name: 'Body 2' }));
      const saving = screen.getByRole('button', { name: 'Saving…' });
      expect(saving).toBeDisabled();
      await act(async () => land());
      await waitFor(() => expect(screen.getByRole('button', { name: 'Edit composition' })).toHaveFocus());
      expect(within(row(1)).queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('a refused save keeps the editor open', async () => {
      vi.spyOn(api, 'updateProductPart').mockRejectedValue(new ApiError('Name taken', 409));
      render(<Host />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit composition' }));
      const name = within(row(1)).getByRole('textbox', { name: 'Part' });
      fireEvent.change(name, { target: { value: 'Lid' } });
      name.focus();
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(await screen.findByText('Name taken')).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Done' })).toBeEnabled();
      expect(within(row(1)).getByRole('textbox', { name: 'Part' })).toBeInTheDocument();
    });

    it('«Edit» in a row’s menu opens the editor on that row, the focus in its name', async () => {
      render(<Host />);
      fireEvent.click(within(row(4)).getByRole('button', { name: 'Actions' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
      await waitFor(() => expect(within(row(4)).getByRole('textbox', { name: 'Part' })).toHaveFocus());
    });

    it('«Delete» in a row’s menu asks with the existing words, deletes, and gives the focus to the heading', async () => {
      const remove = vi.spyOn(api, 'deleteProductPart').mockResolvedValue(undefined as never);
      const { rerender } = render(<Host />);
      fireEvent.click(within(row(4)).getByRole('button', { name: 'Actions' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/recorded as acquired against it/i)).toBeInTheDocument();
      act(() => {
        within(dialog).getByRole('button', { name: 'Delete' }).click();
        within(dialog).getByRole('button', { name: 'Delete' }).click();
      });
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
      expect(remove).toHaveBeenCalledWith(7, 4);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      // The focus went back to the row's menu; the re-read takes the row away.
      expect(within(row(4)).getByRole('button', { name: 'Actions' })).toHaveFocus();
      rerender(<Host product={{ ...product, parts: parts.filter((p) => p.id !== 4) }} />);
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Flask' })).toHaveFocus());
    });

    it('a row the re-read takes while the confirmation is still open: the heading still gets the focus', async () => {
      let rerender: (ui: ReactElement) => void = () => {};
      vi.spyOn(api, 'deleteProductPart').mockImplementation(async () => {
        rerender(<Host product={{ ...product, parts: parts.filter((p) => p.id !== 4) }} />);
        return undefined as never;
      });
      ({ rerender } = render(<Host />));
      fireEvent.click(within(row(4)).getByRole('button', { name: 'Actions' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      const dialog = await screen.findByRole('dialog');
      act(() => within(dialog).getByRole('button', { name: 'Delete' }).click());
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Flask' })).toHaveFocus());
    });

    it('«Add part» opens the existing form in a dialog; it stays open and empty after a part lands', async () => {
      const create = vi.spyOn(api, 'createProductPart').mockResolvedValue(parts[0] as never);
      render(<Host />);
      fireEvent.click(screen.getByRole('button', { name: 'Add part' }));
      const dialog = await screen.findByRole('dialog', { name: 'Add part' });
      const name = within(dialog).getByLabelText('Part');
      fireEvent.change(name, { target: { value: 'Hinge' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(create).toHaveBeenCalledWith(7, expect.objectContaining({ name: 'Hinge', kind: 'printed' })));
      await waitFor(() => expect(within(dialog).getByLabelText('Part')).toHaveValue(''));
      expect(screen.getByRole('dialog', { name: 'Add part' })).toBeInTheDocument();
      await waitFor(() => expect(within(dialog).getByLabelText('Part')).toHaveFocus());
      fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('the add dialog does not close while a part is on its way', async () => {
      let land: () => void = () => {};
      vi.spyOn(api, 'createProductPart').mockReturnValue(new Promise((resolve) => (land = () => resolve(parts[0] as never))));
      render(<Host />);
      fireEvent.click(screen.getByRole('button', { name: 'Add part' }));
      const dialog = await screen.findByRole('dialog', { name: 'Add part' });
      fireEvent.change(within(dialog).getByLabelText('Part'), { target: { value: 'Hinge' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled());
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.getByRole('dialog', { name: 'Add part' })).toBeInTheDocument();
      await act(async () => land());
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Done' })).toBeEnabled());
    });

    it('a refusal to add stands in the dialog, what was typed stays', async () => {
      vi.spyOn(api, 'createProductPart').mockRejectedValue(new ApiError('That name belongs to another part', 409));
      render(<Host />);
      fireEvent.click(screen.getByRole('button', { name: 'Add part' }));
      const dialog = await screen.findByRole('dialog', { name: 'Add part' });
      fireEvent.change(within(dialog).getByLabelText('Part'), { target: { value: 'Lid' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('That name belongs to another part');
      expect(within(dialog).getByLabelText('Part')).toHaveValue('Lid');
    });

    it('«Manage variants…» opens the existing editor; nothing closes it while a change is on its way', async () => {
      let land: () => void = () => {};
      vi.spyOn(api, 'updateVariantGroup').mockReturnValue(new Promise((resolve) => (land = () => resolve({} as never))));
      render(<Host />);
      fireEvent.click(screen.getByRole('button', { name: 'Manage variants…' }));
      const dialog = await screen.findByRole('dialog', { name: 'Product variants' });
      fireEvent.click(within(dialog).getByTestId('variant-option-11-standard'));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled());
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.getByRole('dialog', { name: 'Product variants' })).toBeInTheDocument();
      await act(async () => land());
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Done' })).toBeEnabled());
      fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
  });
});
