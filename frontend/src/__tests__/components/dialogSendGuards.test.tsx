/**
 * A dialog that writes holds one synchronous flag for sending AND for every way out
 * (WS-13 E13 V02): two presses in one frame send once; Cancel, Escape and the header's ×
 * pressed in the same frame as the submit — or while its request is held — close nothing;
 * a refusal keeps what was typed and its explanation and frees one retry; success closes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../utils';
import { api, ApiError } from '../../api/client';
import type { Order, Permission } from '../../api/client';
import { BatchAssignOrderModal } from '../../components/projects/BatchAssignOrderModal';
import { EditArchiveModal } from '../../components/EditArchiveModal';
import { OrderPrints } from '../../components/projects/OrderPrints';

const auth = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      hasPermission: (p: Permission) => auth.granted.has(p),
      canModify: () => true,
    }),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const ALL = ['orders:read', 'orders:update', 'orders:file_prints', 'archives:update_all', 'products:update', 'customers:update', 'stock:move', 'stock:adjust'];

const flasks = {
  id: 5,
  code: 'OR-0005',
  name: 'Flasks',
  status: 'active',
  customer_name: null,
  lines: [{ id: 10, product_name: 'Flask', quantity: 2, mode: 'product', archive_ids: [], configuration: { choices: [], changed_parts: [] } }],
};

beforeEach(() => {
  vi.restoreAllMocks();
  auth.granted = new Set(ALL);
  vi.spyOn(api, 'getOrdersPaged').mockResolvedValue({
    items: [flasks],
    meta: { total: 1, current_page: 1, per_page: 20, last_page: 1 },
    totals: { active: 1, completed: 0, cancelled: 0, all: 1, stages: {} },
  } as never);
  vi.spyOn(api, 'getOrder').mockResolvedValue(flasks as never);
  vi.spyOn(api, 'getPrinters').mockResolvedValue([] as never);
  vi.spyOn(api, 'getTags').mockResolvedValue([] as never);
});

describe('BatchAssignOrderModal', () => {
  async function opened(onClose: () => void) {
    render(<BatchAssignOrderModal archiveIds={[3]} bound={{ orderId: 5, lineId: null }} onClose={onClose} />);
    const assign = await screen.findByRole('button', { name: 'Assign' });
    await waitFor(() => expect(assign).toBeEnabled());
    return assign;
  }

  it.each([
    ['Cancel', () => screen.getByRole('button', { name: 'Cancel' }).click()],
    ['Escape', escape],
    ['the ×', () => within(screen.getByRole('dialog')).getAllByRole('button', { name: /close/i })[0].click()],
  ])('a submit and %s in one frame close nothing while the request is held', async (_name, leave) => {
    const held = deferred<{ message: string }>();
    const add = vi.spyOn(api, 'addArchivesToOrder').mockReturnValue(held.promise);
    const onClose = vi.fn();
    const assign = await opened(onClose);
    act(() => {
      assign.click();
      leave();
    });
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => held.resolve({ message: 'ok' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('a refusal keeps the dialog and its explanation, and frees one retry', async () => {
    const add = vi
      .spyOn(api, 'addArchivesToOrder')
      .mockRejectedValueOnce(new ApiError('This order is closed', 409))
      .mockResolvedValue({ message: 'ok' });
    const onClose = vi.fn();
    const assign = await opened(onClose);
    fireEvent.click(assign);
    expect(await screen.findByRole('alert')).toHaveTextContent('This order is closed');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(add).toHaveBeenCalledTimes(2);
  });
});

describe('EditArchiveModal', () => {
  const archive = {
    id: 7,
    printer_id: null,
    project_id: 5,
    project_line_id: null,
    project_name: 'Flasks',
    filename: 'flask.gcode.3mf',
    print_name: 'Flask',
    status: 'completed',
    tags: '',
    notes: '',
    quantity: 1,
    defective_count: 0,
    photos: null,
    failure_reason: null,
    external_url: null,
    created_at: '2026-01-01T00:00:00Z',
  };

  async function opened(onClose: () => void) {
    render(<EditArchiveModal archive={archive as never} onClose={onClose} />);
    await screen.findByRole('option', { name: 'Flask × 2' });
    fireEvent.change(screen.getByPlaceholderText(/notes/i), { target: { value: 'checked' } });
    return screen.getByRole('button', { name: /save/i });
  }

  it('two presses of «Save» in one frame send one PATCH', async () => {
    const held = deferred<never>();
    const patch = vi.spyOn(api, 'updateArchive').mockReturnValue(held.promise);
    const save = await opened(() => {});
    act(() => {
      save.click();
      save.click();
    });
    await waitFor(() => expect(patch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Cancel', () => screen.getByRole('button', { name: 'Cancel' }).click()],
    ['Escape', escape],
  ])('«Save» and %s in one frame — and while the PATCH is held — close nothing', async (_name, leave) => {
    const held = deferred<never>();
    vi.spyOn(api, 'updateArchive').mockReturnValue(held.promise);
    const onClose = vi.fn();
    const save = await opened(onClose);
    act(() => {
      save.click();
      leave();
    });
    expect(onClose).not.toHaveBeenCalled();
    await screen.findByRole('button', { name: /saving/i });
    act(() => leave());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a refused save keeps the edit and its explanation; one retry saves the binding with the note and closes', async () => {
    const patch = vi
      .spyOn(api, 'updateArchive')
      .mockRejectedValueOnce(new ApiError('This order is closed', 409))
      .mockResolvedValue({} as never);
    const onClose = vi.fn();
    const save = await opened(onClose);
    fireEvent.change(screen.getByLabelText('Line'), { target: { value: '10' } });
    fireEvent.click(save);
    expect(await screen.findByText('This order is closed')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/notes/i)).toHaveValue('checked');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1][1]).toMatchObject({ notes: 'checked', project_id: 5, project_line_id: 10 });
  });
});

describe('OrderPrints — «File under a line»', () => {
  it('two presses of «File» in one frame send one request, and the dialog stays while it is held', async () => {
    vi.spyOn(api, 'getProjectArchives').mockResolvedValue([
      { id: 1, filename: 'a.3mf', status: 'completed', project_line_id: null, created_by_id: 5 },
    ] as never);
    const held = deferred<{ message: string }>();
    const add = vi.spyOn(api, 'addArchivesToOrder').mockReturnValue(held.promise);
    render(<OrderPrints order={{ ...flasks, other_archive_ids: [1] } as unknown as Order} canEdit />);
    fireEvent.click(await screen.findByTestId('print-menu-1'));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /file under/i }));
    const dialog = await screen.findByRole('dialog', { name: 'File under a line' });
    fireEvent.change(within(dialog).getByLabelText('Line'), { target: { value: '10' } });
    const file = within(dialog).getByRole('button', { name: 'File' });
    act(() => {
      file.click();
      file.click();
      within(dialog).getByRole('button', { name: 'Cancel' }).click();
    });
    await waitFor(() => expect(add).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(add).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'File under a line' })).toBeInTheDocument();
  });
});
