/**
 * The order's cover: a 48 px picture at the head of the header and a dialog
 * that uploads or removes it (WS-13 E3 C05). The mutations are the ones the old
 * cover column carried; what moved is where the refusal and the wait show.
 *
 * The cover URL is the bare one the client builds — no cache-buster. It used to
 * carry a `?v=` counter, because replacing a cover keeps the same URL; the
 * endpoint now answers `Cache-Control: private, no-cache`, so the browser
 * revalidates, and a second freshness rule here could only disagree with the
 * first. A hard-coded `&v=` had already produced `…/cover-image&v=0` on a cold
 * page once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { OrderCoverDialog, OrderCoverThumb } from '../../../components/projects/OrderCover';
import { makeOrder } from '../../fixtures/orderDetail';

const withCover = makeOrder({ cover_image_filename: 'cover.jpg' });

describe('OrderCoverThumb', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the URL as it comes, with no token loaded yet', () => {
    vi.spyOn(api, 'getProjectCoverImageUrl').mockReturnValue('/api/v1/projects/1/cover-image');
    render(<OrderCoverThumb order={withCover} canEdit onOpen={() => {}} />);
    expect(screen.getByTestId('order-cover-image')).toHaveAttribute('src', '/api/v1/projects/1/cover-image');
  });

  it('adds nothing to the query string the token opened', () => {
    vi.spyOn(api, 'getProjectCoverImageUrl').mockReturnValue('/api/v1/projects/1/cover-image?token=x');
    render(<OrderCoverThumb order={withCover} canEdit onOpen={() => {}} />);
    const src = screen.getByTestId('order-cover-image').getAttribute('src') ?? '';
    expect(src).toBe('/api/v1/projects/1/cover-image?token=x');
    expect(src).not.toContain('v=');
  });

  it('shows nothing at all without a cover, to an editor or a viewer', () => {
    // `null`, not an empty fragment: React renders both as nothing, and only
    // one of them says so to the next reader.
    render(
      <div data-testid="cover-slot">
        <OrderCoverThumb order={makeOrder()} canEdit={false} onOpen={() => {}} />
        <OrderCoverThumb order={makeOrder()} canEdit onOpen={() => {}} />
      </div>,
    );
    expect(screen.getByTestId('cover-slot')).toBeEmptyDOMElement();
  });
});

describe('OrderCoverDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uploads the picked file through the order’s cover endpoint', async () => {
    const upload = vi.spyOn(api, 'uploadProjectCoverImage').mockResolvedValue({} as never);
    render(<OrderCoverDialog order={makeOrder()} onClose={() => {}} />);

    const file = new File(['x'], 'cover.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('order-cover-input'), { target: { files: [file] } });

    await waitFor(() => expect(upload).toHaveBeenCalledWith(1, file));
  });

  it('asks before removing a cover, naming the order and what goes (E13 E01); none to remove — no offer', async () => {
    const remove = vi.spyOn(api, 'deleteProjectCoverImage').mockResolvedValue({} as never);
    const { unmount } = render(<OrderCoverDialog order={withCover} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const ask = await screen.findByRole('dialog', { name: 'Remove the cover of «Ten flasks»?' });
    expect(ask).toHaveTextContent(
      'The uploaded cover picture is deleted. The order’s attachments and the library’s files stay.',
    );
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove cover' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(1));
    unmount();

    render(<OrderCoverDialog order={makeOrder()} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('shows a refusal inside the dialog, which stays open', async () => {
    vi.spyOn(api, 'uploadProjectCoverImage').mockRejectedValue(new Error('File too large'));
    const onClose = vi.fn();
    render(<OrderCoverDialog order={makeOrder()} onClose={onClose} />);

    fireEvent.change(screen.getByTestId('order-cover-input'), {
      target: { files: [new File(['x'], 'big.png', { type: 'image/png' })] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('File too large');
    expect(onClose).not.toHaveBeenCalled();
  });
});
