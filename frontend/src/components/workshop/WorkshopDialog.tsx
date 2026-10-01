import { useId, type CSSProperties, type ReactNode } from 'react';
import { Modal } from '../Modal';

export type WorkshopDialogSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * The Workshop's own widths (WS-13 E2 D01), NOT the app's `MODAL_SIZE_CLASS`:
 * the app's `lg` is another width, and changing that table would move every
 * dialog outside the Workshop. The overlay's `p-4` already caps the panel at
 * `W − 32`; the inline `maxWidth` beats the size class (Modal invariant).
 */
const WIDTH: Record<WorkshopDialogSize, string> = {
  sm: '448px',
  md: '560px',
  lg: 'min(1000px, 94vw)',
  xl: 'min(1560px, 95vw)',
};

interface WorkshopDialogProps {
  onClose: () => void;
  title: ReactNode;
  /** One line under the header; it describes the dialog (`aria-describedby`). */
  subtitle?: ReactNode;
  size?: WorkshopDialogSize;
  /** The form's own pending flag: the X and Escape stop closing while it is set. */
  pending?: boolean;
  /** The form's error, shown before the footer as an alert. The dialog clears
   *  nothing — what was typed stays where it was. */
  error?: ReactNode;
  /** The actions, cancel before primary. A submit button here belongs to a form in
   *  the body through its `form` attribute — one form, one submit. */
  footer?: ReactNode;
  /** A short figure on the footer's left (e.g. «3 lines»). */
  summary?: ReactNode;
  children: ReactNode;
}

/**
 * The Workshop dialog frame (WS-13 E2 §D): the one Modal — its overlay, stack,
 * focus and Escape — with the Workshop's widths, paddings, subtitle and error
 * slots. A frame and nothing more: whether the form may be sent, what it sends,
 * what a refusal means and whether leaving loses a draft are the form's
 * questions, not this component's.
 *
 * The panel carries the `workshop` scope class itself: the dialog is portalled
 * into `body`, outside every page root that carries it.
 */
export function WorkshopDialog({
  onClose,
  title,
  subtitle,
  size = 'md',
  pending = false,
  error,
  footer,
  summary,
  children,
}: WorkshopDialogProps) {
  const subtitleId = useId();
  const panelStyle: CSSProperties = { maxWidth: WIDTH[size] };
  const hasFooter = footer !== undefined || summary !== undefined;
  return (
    <Modal
      onClose={onClose}
      title={title}
      closeDisabled={pending}
      describedBy={subtitle !== undefined ? subtitleId : undefined}
      panelClassName="workshop"
      panelStyle={panelStyle}
      bodyClassName="px-4 pt-3 pb-4"
      subheader={
        subtitle !== undefined ? (
          // A subtitle names an order or a product: one long word wraps, it never scrolls sideways.
          <p id={subtitleId} className="px-4 pt-3 text-sm text-bambu-gray break-words">
            {subtitle}
          </p>
        ) : undefined
      }
      alert={
        error !== undefined && error !== null && error !== false ? (
          <div
            role="alert"
            className="mx-4 mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400"
          >
            {error}
          </div>
        ) : undefined
      }
      footer={
        hasFooter ? (
          <div data-workshop-dialog-footer className="flex w-full flex-wrap items-center justify-end gap-2">
            {summary !== undefined && <div className="mr-auto min-w-0 text-sm text-bambu-gray">{summary}</div>}
            {footer}
          </div>
        ) : undefined
      }
    >
      {children}
    </Modal>
  );
}
