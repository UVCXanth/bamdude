/**
 * A part's picture (spec part-thumbnails §12.1; plan E5, D1–D4): the small one through its own
 * address, the same box in every state, the app's media-token recovery, and a larger picture in a
 * popover that an Escape closes alone — the dialog behind it stays. Every token here is a fake.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../utils';
import { setMediaToken } from '../../api/client';
import type { InstanceImageRef, PartImageRef } from '../../api/client';
import { Modal } from '../../components/Modal';
import { InstanceThumb, PartThumb } from '../../components/PartThumb';

const ready: PartImageRef = { kind: 'render', status: 'ready', v: 'abc123' };
const pending: PartImageRef = { kind: 'render', status: 'pending', v: null };

afterEach(() => {
  vi.restoreAllMocks();
  setMediaToken(null);
});

describe('PartThumb', () => {
  it('a ready picture: the small one through its address, lazy, named by the part', () => {
    render(<PartThumb partId={5} image={ready} name="Body" />);
    const img = screen.getByTestId('part-thumb-img');
    expect(img).toHaveAttribute('src', '/api/v1/product-parts/5/image?v=abc123&size=sm');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('alt', 'Body');
    expect(screen.getByTestId('part-thumb')).toHaveAttribute('data-state', 'ready');
  });

  it('keeps the same box in every state — nothing shifts when the picture arrives', () => {
    const { rerender } = render(<PartThumb partId={5} image={null} name="Body" size="sm" />);
    const box = () => screen.getByTestId('part-thumb').firstElementChild as HTMLElement;
    expect(box()).toHaveClass('h-8', 'w-8');
    rerender(<PartThumb partId={5} image={pending} name="Body" size="sm" />);
    expect(box()).toHaveClass('h-8', 'w-8');
    rerender(<PartThumb partId={5} image={ready} name="Body" size="sm" />);
    expect(box()).toHaveClass('h-8', 'w-8');
  });

  it('pending: a quiet placeholder that says so, and no picture is asked', () => {
    render(<PartThumb partId={5} image={pending} name="Body" />);
    expect(screen.getByRole('img', { name: 'Body: the picture is being prepared' })).toBeInTheDocument();
    expect(screen.queryByTestId('part-thumb-img')).not.toBeInTheDocument();
    expect(screen.getByTestId('part-thumb')).toHaveAttribute('data-state', 'pending');
  });

  it('no picture: the glyph of the part’s kind, silent for a screen reader', () => {
    const { rerender } = render(<PartThumb partId={5} image={undefined} name="Body" />);
    expect(screen.getByTestId('part-thumb').querySelector('[data-glyph="printed"]')).not.toBeNull();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    rerender(<PartThumb partId={6} image={null} name="Magnet" kind="purchased" />);
    expect(screen.getByTestId('part-thumb').querySelector('[data-glyph="purchased"]')).not.toBeNull();
  });

  it('a new v is a new address — the browser never keeps the old picture', () => {
    const { rerender } = render(<PartThumb partId={5} image={ready} name="Body" />);
    rerender(<PartThumb partId={5} image={{ ...ready, v: 'def456' }} name="Body" />);
    expect(screen.getByTestId('part-thumb-img').getAttribute('src')).toContain('v=def456');
  });

  it('a failure with the token shows the glyph over the kept picture; a load takes it away', () => {
    setMediaToken('fake-token');
    render(<PartThumb partId={5} image={ready} name="Body" />);
    const img = screen.getByTestId('part-thumb-img');
    fireEvent.error(img);
    expect(img).not.toBeVisible();
    expect(img).toBeInTheDocument(); // the recovery retries INTO it (D2)
    expect(screen.getByTestId('part-thumb').querySelector('[data-glyph="printed"]')).not.toBeNull();
    fireEvent.load(img);
    expect(img).toBeVisible();
  });

  it('a failure of a picture asked before the token existed is not counted: the token’s arrival retries it', () => {
    render(<PartThumb partId={5} image={ready} name="Body" />);
    const img = screen.getByTestId('part-thumb-img');
    expect(img.getAttribute('src')).not.toContain('token=');
    fireEvent.error(img);
    expect(img).toBeVisible();
  });
});

describe('the larger picture (D4)', () => {
  it('a click opens it with the large size; a second click closes it', () => {
    render(<PartThumb partId={5} image={ready} name="Body" />);
    const button = screen.getByRole('button', { name: 'Show Body larger' });
    fireEvent.click(button);
    const zoom = screen.getByTestId('part-thumb-zoom');
    expect(zoom.querySelector('img')).toHaveAttribute('src', '/api/v1/product-parts/5/image?v=abc123&size=lg');
    expect(zoom).toHaveClass('fixed', 'z-[49]', 'pointer-events-none');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(button);
    expect(screen.queryByTestId('part-thumb-zoom')).not.toBeInTheDocument();
  });

  it('hovering opens it, leaving closes it', () => {
    render(<PartThumb partId={5} image={ready} name="Body" />);
    fireEvent.mouseEnter(screen.getByTestId('part-thumb'));
    expect(screen.getByTestId('part-thumb-zoom')).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByTestId('part-thumb'));
    expect(screen.queryByTestId('part-thumb-zoom')).not.toBeInTheDocument();
  });

  it('nothing to enlarge without a ready picture, and never with zoom="none"', () => {
    const { rerender } = render(<PartThumb partId={5} image={pending} name="Body" />);
    fireEvent.mouseEnter(screen.getByTestId('part-thumb'));
    expect(screen.queryByTestId('part-thumb-zoom')).not.toBeInTheDocument();
    rerender(<PartThumb partId={5} image={ready} name="Body" zoom="none" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByTestId('part-thumb'));
    expect(screen.queryByTestId('part-thumb-zoom')).not.toBeInTheDocument();
  });

  it('zoom="hover" opens on hover and is no button — in the gallery a click chooses', () => {
    render(<PartThumb partId={5} image={ready} name="Body" zoom="hover" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByTestId('part-thumb'));
    expect(screen.getByTestId('part-thumb-zoom')).toBeInTheDocument();
  });

  it('a pointer outside and a scroll close it', () => {
    render(<PartThumb partId={5} image={ready} name="Body" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Body larger' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('part-thumb-zoom')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show Body larger' }));
    fireEvent.scroll(window);
    expect(screen.queryByTestId('part-thumb-zoom')).not.toBeInTheDocument();
  });

  it('in a dialog, Escape closes the popover alone; the next Escape closes the dialog (Review Focus 2)', () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} title="Edit part">
        <PartThumb partId={5} image={ready} name="Body" />
      </Modal>,
    );
    const button = screen.getByRole('button', { name: 'Show Body larger' });
    fireEvent.click(button);
    expect(screen.getByTestId('part-thumb-zoom')).toBeInTheDocument();
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByTestId('part-thumb-zoom')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a newer modal’s Escape is that modal’s: the covered larger picture does not take it (E5-R2)', () => {
    const lower = vi.fn();
    const upper = vi.fn();
    function Layers({ top }: { top: boolean }) {
      return (
        <>
          <Modal onClose={lower} title="Edit part">
            <PartThumb partId={5} image={ready} name="Body" />
          </Modal>
          {top && (
            <Modal onClose={upper} title="Confirm">
              <p>Sure?</p>
            </Modal>
          )}
        </>
      );
    }
    const { rerender } = render(<Layers top={false} />);
    // opened by hover — it outlives the focus moving into the newer modal
    fireEvent.mouseEnter(screen.getByTestId('part-thumb'));
    expect(screen.getByTestId('part-thumb-zoom')).toBeInTheDocument();
    rerender(<Layers top />);
    fireEvent.keyDown(screen.getByText('Sure?'), { key: 'Escape' });
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
  });
});

describe('InstanceThumb', () => {
  const object: InstanceImageRef = { library_file_id: 9, plate_index: 1, identify_id: 4, status: 'ready', v: 'v1' };

  it('a ready object: its picture under its product, through its own address', () => {
    render(<InstanceThumb productId={2} image={object} name="cube.stl" />);
    expect(screen.getByTestId('part-thumb-img')).toHaveAttribute(
      'src',
      '/api/v1/products/2/files/9/plates/1/objects/4/image?v=v1&size=sm',
    );
  });

  it('missing and skipped show the glyph; pending says it is being prepared', () => {
    const { rerender } = render(<InstanceThumb productId={2} image={{ ...object, status: 'missing', v: null }} name="cube.stl" />);
    expect(screen.getByTestId('part-thumb')).toHaveAttribute('data-state', 'none');
    rerender(<InstanceThumb productId={2} image={{ ...object, status: 'skipped', v: null }} name="cube.stl" />);
    expect(screen.getByTestId('part-thumb')).toHaveAttribute('data-state', 'none');
    rerender(<InstanceThumb productId={2} image={{ ...object, status: 'pending', v: null }} name="cube.stl" />);
    expect(screen.getByRole('img', { name: 'cube.stl: the picture is being prepared' })).toBeInTheDocument();
  });
});
