/**
 * `LivePartThumb` (spec procurement-stock-images R5, A12, A15): the picture a stock or order view
 * shows is read apart from the view's figures — the view's own picture until that read answers,
 * then its answer, «no picture» included; one request for every part on screen.
 */
import { StrictMode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { render as bare } from '@testing-library/react';
import { createAppQueryClient } from '../../utils/appQueryClient';
import { afterEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, render, screen, waitFor } from '../utils';
import { server } from '../mocks/server';
import type { PartImageMeta, PartImageRef } from '../../api/client';
import { LivePartThumb } from '../../components/PartThumb';

const ready = (v: string): PartImageRef => ({ kind: 'render', status: 'ready', v });

/** Answers the batch read from `pictures`; every request's ids are recorded. */
function serve(pictures: Record<number, PartImageRef | null>, options: { hold?: Promise<void> } = {}) {
  const requests: number[][] = [];
  server.use(
    http.get('/api/v1/product-parts/images', async ({ request }) => {
      const ids = new URL(request.url).searchParams.getAll('part_ids').map(Number);
      requests.push(ids);
      if (options.hold) await options.hold;
      const rows: PartImageMeta[] = ids.map((id) => ({
        part_id: id,
        product_id: id in pictures ? 1 : null,
        image: pictures[id] ?? null,
      }));
      return HttpResponse.json(rows);
    }),
  );
  return requests;
}

const shown = () => screen.getAllByTestId('part-thumb').map((el) => el.getAttribute('data-state'));
const source = () => screen.getByTestId('part-thumb-img').getAttribute('src') ?? '';

afterEach(() => server.resetHandlers());

describe('LivePartThumb', () => {
  it('shows the view’s own picture until its read answers, then the answer', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    serve({ 7: ready('fresh') }, { hold });
    render(<LivePartThumb partId={7} name="Lid" image={{ kind: 'render', status: 'pending', v: null }} />);
    expect(shown()).toEqual(['pending']);
    await act(async () => release());
    await waitFor(() => expect(shown()).toEqual(['ready']));
    expect(source()).toContain('v=fresh');
  });

  it('takes «no picture» from its read over the view’s picture — a removed photo goes', async () => {
    serve({ 7: null });
    render(<LivePartThumb partId={7} name="Lid" image={ready('old-photo')} />);
    await waitFor(() => expect(shown()).toEqual(['none']));
  });

  it('keeps the view’s picture when its read fails', async () => {
    server.use(http.get('/api/v1/product-parts/images', () => HttpResponse.json({ detail: 'down' }, { status: 502 })));
    render(<LivePartThumb partId={7} name="Lid" image={ready('own')} />);
    await waitFor(() => expect(source()).toContain('v=own'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source()).toContain('v=own');
  });

  it('asks once for every part on screen, a part shown twice included', async () => {
    const pictures = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i + 1, ready(`p${i + 1}`)]));
    const requests = serve(pictures);
    render(
      <StrictMode>
        {Array.from({ length: 100 }, (_, i) => (
          <LivePartThumb key={i} partId={i + 1} name={`P${i + 1}`} image={null} />
        ))}
        <LivePartThumb partId={1} name="P1 again" image={null} />
      </StrictMode>,
    );
    await waitFor(() => expect(shown().every((state) => state === 'ready')).toBe(true));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveLength(100);
  });

  it('reads its picture again whenever it is shown again — the app keeps other answers fresh for a minute', async () => {
    // Spec R5: a remount checks the picture. A view opened since may carry a newer picture than the
    // cached one, which would otherwise win over it for as long as the app's staleTime lasts.
    const requests = serve({ 7: ready('fresh') });
    const client = createAppQueryClient();
    const view = () => (
      <QueryClientProvider client={client}>
        <LivePartThumb partId={7} name="Lid" image={null} />
      </QueryClientProvider>
    );
    const first = bare(view());
    await waitFor(() => expect(requests).toHaveLength(1));
    first.unmount();
    bare(view());
    await waitFor(() => expect(requests).toHaveLength(2));
    client.clear();
  });

  it('asks nothing for a part not saved yet', async () => {
    const requests = serve({});
    render(<LivePartThumb partId={0} name="New" image={null} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([]);
  });

  it('never shows the picture of the part it showed before', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    serve({ 1: ready('one'), 2: ready('two') }, { hold });
    const { rerender } = render(<LivePartThumb partId={1} name="A" image={ready('a-own')} />);
    rerender(<LivePartThumb partId={2} name="B" image={null} />);
    expect(shown()).toEqual(['none']); // B's own picture — never A's
    await act(async () => release());
    await waitFor(() => expect(source()).toContain('v=two'));
  });
});
