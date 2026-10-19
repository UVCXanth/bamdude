import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Hourglass, ShoppingBag } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { InstanceImageRef, PartImageRef, PartImageSize, ProductPartKind } from '../api/client';
import { mediaRetryStarted } from '../hooks/useCameraStreamToken';
import { matForImage, type PartMat } from './partTone';

export type PartThumbSize = 'xs' | 'sm' | 'md';
/** `click` — hover or a click (a touch) opens the larger picture; `hover` — hover only (the editor's
 *  gallery, where a click chooses); `none` — never. Focus never opens it: a tab through a table
 *  would flash a popover on every row (plan E5, D4). */
export type PartThumbZoom = 'click' | 'hover' | 'none';

type FrameState = 'ready' | 'pending' | 'none';

// Spec part-thumbnails §12.1, plan E5 D3: a fixed box per size; every size asks the 128 px picture.
const BOX: Record<PartThumbSize, string> = { xs: 'h-4 w-4', sm: 'h-8 w-8', md: 'h-16 w-16' };
const GLYPH: Record<PartThumbSize, string> = { xs: 'h-3 w-3', sm: 'h-4 w-4', md: 'h-7 w-7' };
const ZOOM_PX = 256;
const MARGIN_PX = 8;
// A picture with transparency sits on the mat its part's tone asks for (components/partTone.ts): no one backdrop
// reads every filament colour. Until it has loaded -- and for a photo, a glyph or a broken picture -- the frame
// is the theme's own.
const MAT: Record<PartMat, string> = { dark: 'bg-part-mat-dark', light: 'bg-part-mat-light' };

function Glyph({ kind, size }: { kind: ProductPartKind | 'pending'; size: PartThumbSize }) {
  // a queued picture has its own quiet mark: it must not read as «no picture» (final review 1)
  const Icon = kind === 'pending' ? Hourglass : kind === 'purchased' ? ShoppingBag : Box;
  return <Icon data-glyph={kind} className={`${GLYPH[size]} text-bambu-gray`} aria-hidden="true" />;
}

/**
 * The picture itself — keyed by its address, so a failure belongs to that picture alone
 * (`ProductThumb`'s rule, WS-13 E8-V01). The `<img>` never leaves the page: the app's one
 * media-token recovery (`useStreamTokenSync`) retries INTO it. A failure it already answers
 * (`mediaRetryStarted`), or one asked before the token existed, is not counted.
 */
function Picture({
  src,
  alt,
  kind,
  size,
  failed,
  onFailed,
  onMat,
}: {
  src: string;
  alt: string;
  kind: ProductPartKind;
  size: PartThumbSize;
  failed: boolean;
  onFailed: (failed: boolean) => void;
  onMat: (mat: PartMat | null) => void;
}) {
  return (
    <>
      <img
        data-testid="part-thumb-img"
        src={src}
        alt={alt}
        // A failed picture is asked again at once: a hidden LAZY image may never be fetched in a browser
        // that defers what is not rendered, and the recovery retries into this very element (final review 9).
        loading={failed ? 'eager' : 'lazy'}
        hidden={failed}
        onLoad={(e) => {
          onFailed(false);
          onMat(matForImage(e.currentTarget));
        }}
        onError={(e) => {
          const el = e.currentTarget;
          if (mediaRetryStarted(el)) return;
          if (!new URL(el.getAttribute('src') ?? '', window.location.href).searchParams.has('token')) return;
          onFailed(true);
        }}
        className="h-full w-full object-contain"
      />
      {failed && <Glyph kind={kind} size={size} />}
    </>
  );
}

/** Right of the thumb when it fits, else left; vertically centred on it, inside the viewport. */
function zoomPosition(anchor: DOMRect): { left: number; top: number } {
  const right = anchor.right + MARGIN_PX;
  const left =
    right + ZOOM_PX + MARGIN_PX <= window.innerWidth ? right : Math.max(MARGIN_PX, anchor.left - MARGIN_PX - ZOOM_PX);
  const top = Math.min(
    Math.max(MARGIN_PX, anchor.top + anchor.height / 2 - ZOOM_PX / 2),
    Math.max(MARGIN_PX, window.innerHeight - ZOOM_PX - MARGIN_PX),
  );
  return { left, top };
}

interface FrameProps {
  state: FrameState;
  src: string | null;
  zoomSrc: string | null;
  name: string;
  kind: ProductPartKind;
  size: PartThumbSize;
  zoom: PartThumbZoom;
}

function ThumbFrame({ state, src, zoomSrc, name, kind, size, zoom }: FrameProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [held, setHeld] = useState(false);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // The address whose picture failed: a failure belongs to that picture alone, and a broken one opens no
  // larger one (final review 7) — the next version starts clean.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = src !== null && failedSrc === src;
  // The mat belongs to the picture it was read off, like a failure: a new version starts on the theme's frame.
  const [matOf, setMatOf] = useState<{ src: string; mat: PartMat } | null>(null);
  const mat = !failed && src !== null && matOf?.src === src ? matOf.mat : null;
  // The door stays what it is when the picture fails: swapping the button for a span would remount the
  // <img> the media-token recovery retries into. A failure only keeps the larger picture shut.
  const zoomDoor = state === 'ready' && zoom !== 'none' && zoomSrc !== null;
  const zoomable = zoomDoor && !failed;
  const open = zoomable && (hovered || held);

  const place = () => {
    if (root.current) setAt(zoomPosition(root.current.getBoundingClientRect()));
  };

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setHovered(false);
      setHeld(false);
    };
    // The upper INNER layer owns this Escape (plan E5 r2, E5-R2): in the CAPTURE phase on `document` —
    // before every bubble listener, the alias field's `useInnerEscape` too, and the modal stack's on
    // `window` — and stopped there, so one Escape does one thing. A stopPropagation in a bubble
    // listener would not stop another listener of the same node. Not when a newer modal covers this
    // thumb: the stack has made its layer inert, and the Escape is that modal's.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || root.current?.closest('[inert]')) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !root.current?.contains(e.target)) close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const box = `relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded ${mat ? MAT[mat] : 'bg-bambu-dark-tertiary/60'} ${BOX[size]}`;
  const body: ReactNode =
    state === 'ready' && src ? (
      <Picture
        key={src}
        src={src}
        alt={name}
        kind={kind}
        size={size}
        failed={failed}
        onFailed={(value) => setFailedSrc(value ? src : null)}
        onMat={(value) => setMatOf(value ? { src, mat: value } : null)}
      />
    ) : (
      <Glyph kind={state === 'pending' ? 'pending' : kind} size={size} />
    );
  const pendingLabel = state === 'pending' ? t('products.partThumb.pending', { name }) : undefined;

  return (
    <span
      ref={root}
      data-testid="part-thumb"
      data-state={state}
      className="inline-flex shrink-0 align-middle"
      onMouseEnter={() => {
        if (!zoomable) return;
        place();
        setHovered(true);
      }}
      onMouseLeave={() => setHovered(false)}
    >
      {zoomDoor && zoom === 'click' ? (
        <button
          type="button"
          aria-label={t('products.partThumb.enlarge', { name })}
          aria-expanded={open}
          onClick={() => {
            place();
            setHeld((value) => !value);
            setHovered(false);
          }}
          onBlur={() => setHeld(false)}
          data-mat={mat ?? undefined}
          className={`${box} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green`}
        >
          {body}
        </button>
      ) : (
        <span
          className={box}
          data-mat={mat ?? undefined}
          role={pendingLabel ? 'img' : undefined}
          aria-label={pendingLabel}
          title={pendingLabel}
          aria-hidden={state === 'none' ? true : undefined}
        >
          {body}
        </span>
      )}
      {open && at && zoomSrc && (
        <>
          {/* not-a-modal: popover */}
          <span
            data-testid="part-thumb-zoom"
            style={{ left: at.left, top: at.top, width: ZOOM_PX, height: ZOOM_PX }}
            className={`pointer-events-none fixed z-[49] rounded-lg border border-bambu-dark-tertiary ${mat ? MAT[mat] : 'bg-bambu-dark-secondary'} p-1 shadow-xl`}
          >
            <img src={zoomSrc} alt="" className="h-full w-full object-contain" />
          </span>
        </>
      )}
    </span>
  );
}

/**
 * A part's picture (spec part-thumbnails §12.1): the effective one `resolve` answered — a photo or a
 * render — through the media token; «being prepared» while a plate is queued; otherwise the glyph of
 * a printed or a purchased part. Hover or a click shows it larger (plan E5, D4).
 */
export function PartThumb({
  partId,
  image,
  name,
  kind = 'printed',
  size = 'sm',
  zoom = 'click',
}: {
  partId: number;
  image?: PartImageRef | null;
  name: string;
  kind?: ProductPartKind;
  size?: PartThumbSize;
  zoom?: PartThumbZoom;
}) {
  const state: FrameState = image == null ? 'none' : image.status;
  const url = (s: PartImageSize) => (state === 'ready' && image ? api.partImageUrl(partId, image.v, s) : null);
  return <ThumbFrame state={state} src={url('sm')} zoomSrc={url('lg')} name={name} kind={kind} size={size} zoom={zoom} />;
}

/**
 * One object of a plate the product links (spec §11.1–11.3) — an object no part claims on the
 * plates tab, a candidate in the editor's gallery. `missing` / `skipped` have no picture: the glyph.
 */
export function InstanceThumb({
  productId,
  image,
  name,
  size = 'sm',
  zoom = 'click',
}: {
  productId: number;
  image?: InstanceImageRef | null;
  name: string;
  size?: PartThumbSize;
  zoom?: PartThumbZoom;
}) {
  const state: FrameState =
    image == null ? 'none' : image.status === 'ready' ? 'ready' : image.status === 'pending' ? 'pending' : 'none';
  const url = (s: PartImageSize) =>
    state === 'ready' && image
      ? api.partInstanceImageUrl(productId, image.library_file_id, image.plate_index, image.identify_id, image.v, s)
      : null;
  return <ThumbFrame state={state} src={url('sm')} zoomSrc={url('lg')} name={name} kind="printed" size={size} zoom={zoom} />;
}
