/**
 * Re-reading a product's card from one of its files (WS-13 E9 B03, R02, R08). The list
 * is the linked 3MF containers the reader may see — sliced or not — off the same
 * `/files` the «Plates and files» tab reads; STL, STEP, raw G-code and files without
 * access are not offered. Before the request the dialog says which EMPTY fields the file
 * may fill (WS-13 E10 F01); the request goes only on «Re-read»; a note that nothing could
 * be read keeps the dialog with the note as its error; a success turns the dialog into its
 * result — what was filled, replaced, added, skipped (F02). The notes are CODES — their
 * English lives here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../../utils';
import { api, ApiError } from '../../../../api/client';
import type { ProductFileGroup, ProductFileGroups } from '../../../../api/client';
import { ProductRereadDialog } from '../../../../components/products/detail/ProductRereadDialog';

const product = {
  id: 7,
  code: 'PR-0007',
  name: 'Flask',
  description: 'A flask',
  designer: null,
  license: null,
  design_id: 'MW-1',
};

function file(over: Partial<ProductFileGroup>): ProductFileGroup {
  return {
    library_file_id: 1,
    filename: 'flask.gcode.3mf',
    hidden: false,
    folder_id: 4,
    folder_name: 'Lighting',
    file_type: 'gcode',
    plan_eligible: true,
    printer_model: 'P1S',
    sliced_any: true,
    plates: [],
    is_3mf: true,
    in_linked_folder: false,
    ...over,
  };
}

const groups = (files: ProductFileGroup[]): ProductFileGroups => ({
  files,
  hidden_files: files.filter((f) => f.hidden).length,
  folders: [],
});

const MANY = groups([
  file({ library_file_id: 1, filename: 'flask.gcode.3mf' }),
  file({ library_file_id: 2, filename: 'flask-project.3mf', file_type: '3mf', sliced_any: false, printer_model: null }),
  file({ library_file_id: 3, filename: 'flask.gcode', is_3mf: false }),
  file({ library_file_id: 4, filename: 'flask.stl', file_type: 'stl', is_3mf: false, sliced_any: false }),
  file({ library_file_id: 5, filename: null, hidden: true, folder_id: null, folder_name: null }),
]);

// The page's own query client, reached from inside the tree the dialog renders in.
const probe = vi.hoisted(() => ({ client: null as QueryClient | null }));
function Probe() {
  const client = useQueryClient();
  useEffect(() => {
    probe.client = client;
  }, [client]);
  return null;
}

function mount(onClose = vi.fn()) {
  render(<ProductRereadDialog product={product} onClose={onClose} />);
  return onClose;
}

/** The dialog over a page that already read the files once (`['product-file-groups', 7]`). */
function mountOverCache(cached: ProductFileGroups) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(['product-file-groups', 7], cached);
  render(
    <QueryClientProvider client={client}>
      <ProductRereadDialog product={product} onClose={() => {}} />
    </QueryClientProvider>,
  );
  return client;
}

describe('ProductRereadDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('offers the 3MF containers the reader may see — sliced or not — and nothing is chosen of several', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    mount();
    const radios = await screen.findAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual([
      expect.stringContaining('flask.gcode.3mf'),
      expect.stringContaining('flask-project.3mf'),
    ]);
    expect(screen.getByText('not sliced')).toBeInTheDocument();
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeDisabled();
  });

  it('chooses the only file there is', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(groups([file({ library_file_id: 9 })]));
    mount();
    expect(await screen.findByRole('radio')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeEnabled();
  });

  it('says when there is no 3MF the reader may re-read from', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(
      groups([file({ is_3mf: false, filename: 'a.stl' }), file({ hidden: true, filename: null })]),
    );
    mount();
    expect(await screen.findByText('None of the linked files is a 3MF you can see.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeDisabled();
  });

  it('reads the list while it loads, and a failed read offers a retry', async () => {
    let fail = true;
    vi.spyOn(api, 'getProductFileGroups').mockImplementation(async () => {
      if (fail) throw new ApiError('boom', 500);
      return MANY;
    });
    mount();
    expect(screen.getByText('Loading files…')).toBeInTheDocument();
    const retry = await screen.findByRole('button', { name: /try again|retry/i });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findAllByRole('radio')).toHaveLength(2);
  });

  it('a chosen file that left the list is chosen no more, and says why', async () => {
    const spy = vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    render(
      <>
        <Probe />
        <ProductRereadDialog product={product} onClose={() => {}} />
      </>,
    );
    fireEvent.click((await screen.findAllByRole('radio'))[1]);
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeEnabled();
    spy.mockResolvedValue(groups([file({ library_file_id: 1 }), file({ library_file_id: 8, filename: 'other.3mf' })]));
    // Somebody unlinked it meanwhile: the list is read again.
    await act(async () => {
      await probe.client!.invalidateQueries({ queryKey: ['product-file-groups', 7] });
    });
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByText('This file is no longer linked — pick another.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeDisabled();
  });

  it('the only file, chosen by itself, leaves and another is the only one: nothing is chosen behind the hint', async () => {
    const spy = vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(groups([file({ library_file_id: 1 })]));
    render(
      <>
        <Probe />
        <ProductRereadDialog product={product} onClose={() => {}} />
      </>,
    );
    await waitFor(() => expect(screen.getByRole('radio')).toBeChecked());
    spy.mockResolvedValue(groups([file({ library_file_id: 8, filename: 'other.3mf' })]));
    await act(async () => {
      await probe.client!.invalidateQueries({ queryKey: ['product-file-groups', 7] });
    });
    await waitFor(() => expect(screen.getByText('This file is no longer linked — pick another.')).toBeInTheDocument());
    // The operator saw one file; the dialog does not switch to another behind the hint.
    expect(screen.getByRole('radio', { name: /other\.3mf/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeDisabled();
  });

  it('says before the request which empty fields the file may fill — a filled one is not named', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    mount();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Filled from the file if it has them: designer, licence.');
    expect(dialog).toHaveTextContent('Attachments from this file are replaced; ones added by hand are not.');
  });

  it('with every field filled, says they stay as they are', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    render(
      <ProductRereadDialog product={{ ...product, designer: 'Ada', license: 'CC-BY' }} onClose={() => {}} />,
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('Every field is filled — they stay as they are.');
  });

  it('sends one request on «Re-read» and shows its result in the dialog; «Done» closes', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    const reread = vi.spyOn(api, 'rereadProductCard').mockResolvedValue({
      product,
      notes: [
        { code: 'filled_field', params: { field: 'designer' } },
        { code: 'filled_field', params: { field: 'license' } },
        { code: 'replaced_files', params: { count: 2 } },
        { code: 'imported_files', params: { category: 'bom_docs', count: 1 } },
        { code: 'skipped_unreadable', params: { name: 'notes.pdf' } },
      ],
    } as never);
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    const onClose = mount();
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    const primary = screen.getByRole('button', { name: 'Re-read' });
    // Two clicks in one tick — React has not re-rendered the button disabled between them.
    act(() => {
      primary.click();
      primary.click();
    });
    const result = await screen.findByRole('dialog', { name: 'Card re-read' });
    expect(reread).toHaveBeenCalledTimes(1);
    expect(reread).toHaveBeenCalledWith(7, 1);
    expect(within(result).getByText('Filled in: Designer, Licence')).toBeInTheDocument();
    expect(within(result).getByText('Attachments replaced: 2')).toBeInTheDocument();
    expect(within(result).getByText(/^Added: 1 to /)).toBeInTheDocument();
    expect(within(result).getByText('Skipped notes.pdf — it could not be read.')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['product'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] });
    expect(onClose).not.toHaveBeenCalled();
    const done = within(result).getByRole('button', { name: 'Done' });
    await waitFor(() => expect(done).toHaveFocus());
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a file with nothing to fill says so in the result', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    vi.spyOn(api, 'rereadProductCard').mockResolvedValue({
      product,
      notes: [{ code: 'nothing_to_fill', params: {} }],
    } as never);
    mount();
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Re-read' }));
    const result = await screen.findByRole('dialog', { name: 'Card re-read' });
    expect(within(result).getByText('Nothing to fill — every field already has a value.')).toBeInTheDocument();
  });

  it('a note that nothing could be read keeps the dialog, with the note as its error', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    vi.spyOn(api, 'rereadProductCard').mockResolvedValue({
      product,
      notes: [{ code: 'unreadable', params: { error: 'bad zip' } }],
    } as never);
    const onClose = mount();
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Re-read' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/bad zip/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Re-read' })).toHaveFocus());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a refusal stays in the dialog with the server’s sentence', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    vi.spyOn(api, 'rereadProductCard').mockRejectedValue(new ApiError('That file is not linked to this product', 404));
    const onClose = mount();
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Re-read' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That file is not linked to this product');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('nothing closes it in the frame that sent it — Escape, Cancel and the X before the next render (J; Codex V01)', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    let refuse: (e: Error) => void = () => {};
    const reread = vi
      .spyOn(api, 'rereadProductCard')
      .mockReturnValueOnce(new Promise((_resolve, reject) => (refuse = reject)) as never);
    const onClose = mount();
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    const primary = screen.getByRole('button', { name: 'Re-read' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const x = screen.getByRole('button', { name: 'Close' });
    act(() => {
      primary.click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      cancel.click();
      x.click();
    });
    await waitFor(() => expect(reread).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    // A refusal leaves it open with the sentence, and it may be sent again.
    await act(async () => refuse(new ApiError('That file is not linked to this product', 404)));
    expect(await screen.findByRole('alert')).toHaveTextContent('That file is not linked to this product');
    expect(onClose).not.toHaveBeenCalled();
    reread.mockResolvedValueOnce({ product, notes: [{ code: 'nothing_to_fill', params: {} }] } as never);
    fireEvent.click(screen.getByRole('button', { name: 'Re-read' }));
    expect(await screen.findByRole('dialog', { name: 'Card re-read' })).toBeInTheDocument();
    expect(reread).toHaveBeenCalledTimes(2);
  });

  describe('a refresh that fails over a list it already had (J; Codex V03)', () => {
    it('an empty list says it could not be refreshed, with a retry that reads again', async () => {
      const read = vi
        .spyOn(api, 'getProductFileGroups')
        .mockRejectedValueOnce(new ApiError('boom', 500))
        .mockResolvedValueOnce(MANY);
      mountOverCache(groups([]));
      const note = await screen.findByText('Could not refresh');
      // The empty answer read before the failure is still shown — it is not a current one.
      expect(screen.getByText('None of the linked files is a 3MF you can see.')).toBeInTheDocument();
      fireEvent.click(within(note.closest('p') as HTMLElement).getByRole('button', { name: 'Retry' }));
      expect(await screen.findAllByRole('radio')).toHaveLength(2);
      expect(read).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('Could not refresh')).not.toBeInTheDocument();
    });

    it('a list with files keeps them and the file chosen by hand until an answer shows it gone', async () => {
      const read = vi
        .spyOn(api, 'getProductFileGroups')
        .mockRejectedValueOnce(new ApiError('boom', 500))
        .mockResolvedValueOnce(MANY)
        .mockResolvedValueOnce(groups([file({ library_file_id: 1 })]));
      const client = mountOverCache(MANY);
      fireEvent.click(screen.getAllByRole('radio')[1]);
      const note = await screen.findByText('Could not refresh');
      expect(screen.getAllByRole('radio')[1]).toBeChecked();
      expect(screen.getByRole('button', { name: 'Re-read' })).toBeEnabled();
      fireEvent.click(within(note.closest('p') as HTMLElement).getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.queryByText('Could not refresh')).not.toBeInTheDocument(),
      );
      expect(screen.getAllByRole('radio')[1]).toBeChecked();
      // Only a successful answer that lacks it takes the choice away.
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['product-file-groups', 7] });
      });
      expect(await screen.findByText('This file is no longer linked — pick another.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Re-read' })).toBeDisabled();
    });
  });

  it('cannot be closed while the request runs', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    vi.spyOn(api, 'rereadProductCard').mockReturnValue(new Promise(() => {}));
    const onClose = mount();
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Re-read' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
