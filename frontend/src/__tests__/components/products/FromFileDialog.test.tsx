/**
 * A product from one library file (WS-13 E10 E01–E03, F17): the whole library the
 * reader may see, searched on the server; a row per file with its kind by the NAME,
 * its folder and model or «not sliced»; one creation at a time, a refusal in the
 * dialog, and what the file gave told after it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import { FromFileDialog } from '../../../components/products/FromFileDialog';

function row(over: Record<string, unknown>) {
  return {
    folder_id: 3,
    file_type: '3mf',
    file_tags: ['3mf'],
    sliced_for_model: null,
    thumbnail_path: null,
    ...over,
  };
}

/** The real envelope of `getLibraryFilesPaged`: `{items, meta}`; rows carry `folder_id`. */
const page = {
  items: [
    row({ id: 7, filename: 'flask.gcode.3mf', file_type: 'gcode', file_tags: ['gcode', '3mf'], sliced_for_model: 'P1S' }),
    row({ id: 8, filename: 'flask-project.3mf' }),
    row({ id: 9, filename: 'lid.STL', file_type: 'stl', file_tags: ['stl'], folder_id: null }),
  ],
  meta: { total: 3, current_page: 1, per_page: 20, last_page: 1 },
};

const folders = [
  { id: 3, name: 'Flasks', parent_id: null, products: [], is_external: false, external_path: null, external_readonly: false, file_count: 1, children: [] },
];

const noop = () => {};
const rowOf = (name: string) => screen.getByText(name).closest('[data-testid="from-file-row"]') as HTMLElement;

describe('FromFileDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getLibraryFolders').mockResolvedValue(folders as never);
  });

  describe('the frame and the rows (E01)', () => {
    it('«New product from a file», «Library files», a search, «Close»', async () => {
      vi.spyOn(api, 'getLibraryFilesPaged').mockResolvedValue(page as never);
      render(<FromFileDialog onClose={noop} onCreated={noop} />);
      const dialog = screen.getByRole('dialog', { name: 'New product from a file' });
      expect(dialog).toHaveAccessibleDescription('Library files');
      expect(within(dialog).getByRole('searchbox')).toBeInTheDocument();
      // The header's X and the footer's «Close».
      expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(2);
      await screen.findByText('flask.gcode.3mf');
    });

    it('the kind by the file’s name, the folder and the model — or «not sliced»', async () => {
      vi.spyOn(api, 'getLibraryFilesPaged').mockResolvedValue(page as never);
      render(<FromFileDialog onClose={noop} onCreated={noop} />);
      await screen.findByText('flask.gcode.3mf');
      // A sliced `.gcode.3mf` is a 3MF box, though its `file_type` is «gcode».
      expect(within(rowOf('flask.gcode.3mf')).getByText('3MF')).toBeInTheDocument();
      expect(within(rowOf('flask.gcode.3mf')).getByText('/Flasks · P1S')).toBeInTheDocument();
      expect(within(rowOf('flask-project.3mf')).getByText('not sliced')).toBeInTheDocument();
      expect(within(rowOf('lid.STL')).getByText('STL')).toBeInTheDocument();
      expect(within(rowOf('lid.STL')).getByText('not sliced')).toBeInTheDocument();
    });
  });

  describe('the whole visible library, its reading states (E02)', () => {
    it('lists and searches the whole library, not the root alone — debounced, on the server', async () => {
      const list = vi.spyOn(api, 'getLibraryFilesPaged').mockResolvedValue(page as never);
      render(<FromFileDialog onClose={noop} onCreated={noop} />);
      await screen.findByText('flask.gcode.3mf');
      expect(list).toHaveBeenCalledWith({ include_root: false, page: 1, per_page: 20 });
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'lid' } });
      await waitFor(() => expect(list).toHaveBeenLastCalledWith({ q: 'lid', include_root: false, page: 1, per_page: 20 }));
    });

    it('a failed read says so and retries — never «no files»', async () => {
      const list = vi
        .spyOn(api, 'getLibraryFilesPaged')
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockResolvedValueOnce(page as never);
      render(<FromFileDialog onClose={noop} onCreated={noop} />);
      const failed = await screen.findByRole('alert');
      expect(failed).toHaveTextContent('Could not read the library files.');
      expect(screen.queryByText('No files found')).not.toBeInTheDocument();
      fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('flask.gcode.3mf')).toBeInTheDocument();
      expect(list).toHaveBeenCalledTimes(2);
    });

    it('a page shorter than the library says how much is shown and asks to narrow it', async () => {
      vi.spyOn(api, 'getLibraryFilesPaged').mockResolvedValue({ ...page, meta: { ...page.meta, total: 226 } } as never);
      render(<FromFileDialog onClose={noop} onCreated={noop} />);
      expect(await screen.findByText('Showing the first 3 of 226 — type to narrow')).toBeInTheDocument();
    });

    it('a page that holds the whole answer says nothing more', async () => {
      vi.spyOn(api, 'getLibraryFilesPaged').mockResolvedValue(page as never);
      render(<FromFileDialog onClose={noop} onCreated={noop} />);
      await screen.findByText('flask.gcode.3mf');
      expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
    });

    it('a truly empty answer says so', async () => {
      vi.spyOn(api, 'getLibraryFilesPaged').mockResolvedValue({ items: [], meta: { ...page.meta, total: 0 } } as never);
      render(<FromFileDialog onClose={noop} onCreated={noop} />);
      expect(await screen.findByText('No files found')).toBeInTheDocument();
    });

    it('a new search without its answer does not show the old list as current', async () => {
      let answer: (value: unknown) => void = noop;
      vi.spyOn(api, 'getLibraryFilesPaged')
        .mockResolvedValueOnce(page as never)
        .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);
      render(<FromFileDialog onClose={noop} onCreated={noop} />);
      await screen.findByText('flask.gcode.3mf');
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
      await waitFor(() => expect(screen.queryByText('flask.gcode.3mf')).not.toBeInTheDocument());
      expect(screen.getByRole('status')).toBeInTheDocument();
      await act(async () => answer({ items: [], meta: { ...page.meta, total: 0 } }));
      expect(await screen.findByText('No files found')).toBeInTheDocument();
    });
  });

  describe('the creation (E03)', () => {
    it('creates from the picked file and tells what the file gave', async () => {
      vi.spyOn(api, 'getLibraryFilesPaged').mockResolvedValue(page as never);
      const create = vi.spyOn(api, 'createProductFromFile').mockResolvedValue({
        product: { id: 42, name: 'flask' },
        notes: [{ code: 'filled_field', params: { field: 'designer' } }],
      } as never);
      const onCreated = vi.fn();
      render(<FromFileDialog onClose={noop} onCreated={onCreated} />);
      await screen.findByText('flask.gcode.3mf');
      fireEvent.click(within(rowOf('flask.gcode.3mf')).getByRole('button', { name: 'Create product' }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 42 })));
      expect(create).toHaveBeenCalledWith(7);
      expect(await screen.findByText('Filled in Designer.')).toBeInTheDocument();
    });

    it('without notes, the mockup’s toast', async () => {
      vi.spyOn(api, 'getLibraryFilesPaged').mockResolvedValue(page as never);
      vi.spyOn(api, 'createProductFromFile').mockResolvedValue({ product: { id: 42, name: 'flask' }, notes: [] } as never);
      render(<FromFileDialog onClose={noop} onCreated={noop} />);
      await screen.findByText('flask.gcode.3mf');
      fireEvent.click(within(rowOf('flask.gcode.3mf')).getByRole('button', { name: 'Create product' }));
      expect(await screen.findByText('Product created from the file — parts seeded from its plates')).toBeInTheDocument();
    });

    it('one at a time: the pressed row says «…», the others wait; nothing closes it, nothing sends twice', async () => {
      vi.spyOn(api, 'getLibraryFilesPaged').mockResolvedValue(page as never);
      const create = vi.spyOn(api, 'createProductFromFile').mockReturnValue(new Promise(() => {}) as never);
      const onClose = vi.fn();
      render(<FromFileDialog onClose={onClose} onCreated={noop} />);
      await screen.findByText('flask.gcode.3mf');
      const first = within(rowOf('flask.gcode.3mf')).getByRole('button', { name: 'Create product' });
      const second = within(rowOf('flask-project.3mf')).getByRole('button', { name: 'Create product' });
      const closes = screen.getAllByRole('button', { name: 'Close' });
      act(() => {
        first.click();
        second.click();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        for (const close of closes) close.click();
      });
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create).toHaveBeenCalledWith(7);
      expect(onClose).not.toHaveBeenCalled();
      expect(within(rowOf('flask.gcode.3mf')).getByRole('button', { name: /…/ })).toBeDisabled();
      expect(within(rowOf('flask-project.3mf')).getByRole('button', { name: 'Create product' })).toBeDisabled();
    });

    it('a refusal stays in the dialog, never a toast', async () => {
      vi.spyOn(api, 'getLibraryFilesPaged').mockResolvedValue(page as never);
      vi.spyOn(api, 'createProductFromFile').mockRejectedValue(new ApiError('Library file not found', 404));
      const onCreated = vi.fn();
      render(<FromFileDialog onClose={noop} onCreated={onCreated} />);
      await screen.findByText('flask.gcode.3mf');
      fireEvent.click(within(rowOf('flask.gcode.3mf')).getByRole('button', { name: 'Create product' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Library file not found');
      expect(screen.getAllByText('Library file not found')).toHaveLength(1);
      expect(onCreated).not.toHaveBeenCalled();
      const pressed = within(rowOf('flask.gcode.3mf')).getByRole('button', { name: 'Create product' });
      expect(pressed).toBeEnabled();
      // The button that sent it, live again — never BODY (J; final review I2).
      await waitFor(() => expect(pressed).toHaveFocus());
    });
  });
});
