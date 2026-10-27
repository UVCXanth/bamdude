/**
 * A picture that changes under an open stock dialog leaves its figures alone (spec
 * procurement-stock-images A08, A10, A11): what the socket re-reads for a picture-only change —
 * `PART_IMAGE_PURE_KEYS` and the pictures — reads no position again, dims nothing and keeps the
 * primary as it was; a structural change still reads the position again and holds the primary
 * until the answer, as G08 asks. The socket's choice between the two is
 * `__tests__/hooks/useWebSocketPartImages.test.tsx`'s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { StockItemDetail } from '../../../api/client';
import { AssembleDialog } from '../../../components/stock/AssembleDialog';
import { StockMoveDialog } from '../../../components/stock/StockMoveDialog';
import { PART_IMAGE_PURE_KEYS, PART_IMAGE_VIEW_KEYS, refreshPartImageRefs } from '../../../utils/queryInvalidation';
import { pipeDetail, pipeItem, pipeProduct } from './stockFixtures';

const handle = { client: null as QueryClient | null };
function Grab() {
  const qc = useQueryClient();
  useEffect(() => {
    handle.client = qc;
  }, [qc]);
  return null;
}

/** What the socket does for a picture-only change at its flush. */
function pictureOnly() {
  for (const key of PART_IMAGE_PURE_KEYS) void handle.client!.invalidateQueries({ queryKey: [...key] });
  refreshPartImageRefs(handle.client!);
}

/** What it does for a structural one: every view key — the stock among them. */
function structural() {
  for (const key of PART_IMAGE_VIEW_KEYS) void handle.client!.invalidateQueries({ queryKey: [...key] });
  refreshPartImageRefs(handle.client!, [pipeItem.product.id]);
}

let getItem: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  getItem = vi.spyOn(api, 'getStockItem').mockResolvedValue({ ...pipeDetail, can_assemble: 3 });
  vi.spyOn(api, 'getStockCatalog').mockResolvedValue([pipeProduct] as never);
  vi.spyOn(api, 'getStockProduct').mockResolvedValue(pipeProduct as never);
  vi.spyOn(api, 'getCustomerOptions').mockResolvedValue([] as never);
  vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
});
afterEach(() => {
  handle.client = null;
});

describe('an open assembly', () => {
  it('keeps its figures and its primary through a picture-only change', async () => {
    render(
      <>
        <Grab />
        <AssembleDialog item={pipeItem} onClose={() => {}} />
      </>,
    );
    const submit = () => screen.getByTestId('assemble-submit');
    await waitFor(() => expect(submit()).toBeEnabled());
    const reads = getItem.mock.calls.length;

    act(() => pictureOnly());
    expect(submit()).toBeEnabled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(getItem.mock.calls.length).toBe(reads);
    expect(submit()).toBeEnabled();
  });

  it('still holds its primary through a structural change until the position answers', async () => {
    render(
      <>
        <Grab />
        <AssembleDialog item={pipeItem} onClose={() => {}} />
      </>,
    );
    const submit = () => screen.getByTestId('assemble-submit');
    await waitFor(() => expect(submit()).toBeEnabled());
    let answer!: (detail: StockItemDetail) => void;
    getItem.mockReturnValue(new Promise<StockItemDetail>((resolve) => (answer = resolve)));

    act(() => structural());
    await waitFor(() => expect(submit()).toBeDisabled());
    await act(async () => answer({ ...pipeDetail, can_assemble: 3 }));
    await waitFor(() => expect(submit()).toBeEnabled());
  });
});

describe('an open stock move', () => {
  it('reads its position once, and nothing dims, through a picture-only change', async () => {
    render(
      <>
        <Grab />
        <StockMoveDialog kind="reserve" item={pipeItem} onClose={() => {}} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('stock-position-header')).toHaveTextContent('On hand 5'));
    const reads = getItem.mock.calls.length;

    act(() => pictureOnly());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(getItem.mock.calls.length).toBe(reads);
    expect(document.querySelector('[data-stale]')).toBeNull();
  });

  it('dims its figures through a structural change until the position answers', async () => {
    render(
      <>
        <Grab />
        <StockMoveDialog kind="reserve" item={pipeItem} onClose={() => {}} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('stock-position-header')).toHaveTextContent('On hand 5'));
    let answer!: (detail: StockItemDetail) => void;
    getItem.mockReturnValue(new Promise<StockItemDetail>((resolve) => (answer = resolve)));

    act(() => structural());
    await waitFor(() => expect(document.querySelector('[data-stale]')).not.toBeNull());
    await act(async () => answer(pipeDetail));
    await waitFor(() => expect(document.querySelector('[data-stale]')).toBeNull());
  });
});
