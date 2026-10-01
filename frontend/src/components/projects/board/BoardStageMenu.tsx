import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { OrderListItem, OrderStage } from '../../../api/client';
import { CardActionMenu, CardActionMenuItem } from '../../CardActionMenu';
import { StageBadge } from '../StageBadge';

const ACTIVE_STAGES: OrderStage[] = ['prep', 'printing', 'qc'];

/**
 * The stage of a board card as a menu (WS-13 E7 F07, R04) — the keyboard
 * alternative to dragging the parent spec asks for (O07 «Select/menu»), local to
 * the board: the order's universal menu (E6) carries no stages.
 *
 * Three `menuitemradio` rows for the active stages (the current one checked,
 * choosing it writes nothing) and, after a separator, a COMMAND — «Done — stock
 * and issue…» — that opens the issue dialog: an order closes by issuing, never by
 * a stage switch (E6-B04).
 */
export function BoardStageMenu({
  order,
  pending,
  onStage,
  onComplete,
}: {
  order: Pick<OrderListItem, 'id' | 'code' | 'stage' | 'status'>;
  pending: boolean;
  onStage: (stage: OrderStage) => void;
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  const current = order.stage;
  return (
    <CardActionMenu
      label={t('orders.board.stageMenu', { code: order.code, stage: current ? t(`orders.stage.${current}`) : '' })}
      testId={`board-card-${order.id}-stage`}
      width="max-content"
      disabled={pending}
      triggerClassName="relative z-10 inline-flex items-center gap-0.5 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green disabled:opacity-60"
      icon={
        <>
          <StageBadge stage={order.stage} status={order.status} />
          <ChevronDown className="h-3 w-3 text-bambu-gray" aria-hidden="true" />
        </>
      }
    >
      {(close) => (
        <>
          {ACTIVE_STAGES.map((stage) => (
            <CardActionMenuItem
              key={stage}
              role="menuitemradio"
              checked={stage === current}
              onSelect={() => {
                close();
                if (stage !== current) onStage(stage);
              }}
            >
              {t(`orders.stage.${stage}`)}
            </CardActionMenuItem>
          ))}
          <div role="separator" className="my-1 border-t border-bambu-dark-tertiary" />
          <CardActionMenuItem
            onSelect={() => {
              close();
              onComplete();
            }}
          >
            {t('orders.board.stageDone')}
          </CardActionMenuItem>
        </>
      )}
    </CardActionMenu>
  );
}
