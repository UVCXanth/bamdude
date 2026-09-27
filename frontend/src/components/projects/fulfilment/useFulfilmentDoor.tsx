import { useState } from 'react';
import { FulfilmentDialog } from './FulfilmentDialog';

/**
 * The «виконано» door of a list (spec workshop-order-issue, rule 28): an order
 * completes only when everything is issued, so «Mark completed» on a card opens
 * the issue dialog prefilled with everything and ticked to close, instead of
 * writing the status. The page renders `fulfilmentDialog` where its modals go.
 */
export function useFulfilmentDoor() {
  const [orderId, setOrderId] = useState<number | null>(null);
  return {
    openFulfilment: (id: number) => setOrderId(id),
    fulfilmentDialog:
      orderId != null ? <FulfilmentDialog orderId={orderId} complete onClose={() => setOrderId(null)} /> : null,
  };
}
