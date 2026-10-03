import type { StockItem } from '../../api/client';
import { AssembleDialog } from './AssembleDialog';
import type { FinishedAction } from './FinishedGoodsTable';
import { StockMoveDialog } from './StockMoveDialog';
import { StockParamsDialog } from './StockParamsDialog';

/** Which dialog is open, and for which position — none for the header's product-first flows;
 *  `productId` alone for a product whose configuration is chosen in the dialog (a free-parts
 *  row's «Assemble», WS-13 E12 D03 / R01). */
export type StockDialogState = { kind: Exclude<FinishedAction, 'open'>; item?: StockItem; productId?: number } | null;

/** The finished-goods dialogs, one at a time — shared by the Stock page and the position page. */
export function StockDialogs({ dialog, onClose }: { dialog: StockDialogState; onClose: () => void }) {
  if (!dialog) return null;
  if (dialog.kind === 'assemble') return <AssembleDialog item={dialog.item} productId={dialog.productId} onClose={onClose} />;
  if (dialog.kind === 'params') return dialog.item ? <StockParamsDialog item={dialog.item} onClose={onClose} /> : null;
  return <StockMoveDialog kind={dialog.kind} item={dialog.item} onClose={onClose} />;
}
