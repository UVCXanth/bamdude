import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, WAYBILL_MAX } from '../../../api/client';
import type { FulfilmentLineState, FulfilmentRecipient, FulfilmentResult, FulfilmentState } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useDeliveryMethods } from '../../../hooks/useDeliveryMethods';
import { invalidateOrderViews } from '../../../utils/queryInvalidation';
import { Button } from '../../Button';
import { Modal } from '../../Modal';
import { Select } from '../../Select';
import { clampDraft, completesOrder, draftFrom, issueCeiling, issuingUnits, requestFrom } from './fulfilmentState';
import type { Draft, FulfilmentMode, LineDraft } from './fulfilmentState';

const NUMBER_CLS =
  'w-20 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white disabled:opacity-50';
const FIELD_CLS = 'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white';

/**
 * «Склад і видача» (spec workshop-order-issue, rule 27): per line — assemble the
 * reserved kits, receive the printed units onto the shelf under the order, issue
 * part of what is there or all; a parts line part by part. One «Виконати» is one
 * batch and at most one issue; «Close the order» is offered only when this batch
 * hands over everything ordered (rule 12).
 *
 * The numbers are the server's (`getFulfilment` — the same state the POST checks
 * under its locks); the draft only keeps the form inside them. A refusal is the
 * server's sentence and the dialog stays.
 */
export function FulfilmentDialog({
  orderId,
  mode = 'all',
  complete = false,
  onClose,
  onDone,
}: {
  orderId: number;
  mode?: FulfilmentMode;
  /** Opened from a «done» door: the close box starts ticked (it still needs a full issue). */
  complete?: boolean;
  onClose: () => void;
  onDone?: (result: FulfilmentResult) => void;
}) {
  const { t } = useTranslation();
  const { data: state, isLoading } = useQuery({
    queryKey: ['project-fulfilment', orderId],
    queryFn: () => api.getFulfilment(orderId),
  });
  return (
    <Modal onClose={onClose} title={t('orders.fulfil.title')} size="6xl">
      {isLoading || !state ? (
        <p className="text-bambu-gray">{t('common.loading')}</p>
      ) : (
        <FulfilmentForm
          orderId={orderId}
          state={state}
          mode={mode}
          complete={complete}
          onClose={onClose}
          onDone={onDone}
        />
      )}
    </Modal>
  );
}

function FulfilmentForm({
  orderId,
  state,
  mode,
  complete: completeAsked,
  onClose,
  onDone,
}: {
  orderId: number;
  state: FulfilmentState;
  mode: FulfilmentMode;
  complete: boolean;
  onClose: () => void;
  onDone?: (result: FulfilmentResult) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const { data: methods = [] } = useDeliveryMethods();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(state, mode));
  const [recipient, setRecipient] = useState<FulfilmentRecipient>(state.recipient);
  const [waybill, setWaybill] = useState('');
  const [note, setNote] = useState('');
  const [closeAsked, setCloseAsked] = useState(completeAsked);
  const [error, setError] = useState<string | null>(null);

  const completes = completesOrder(state, draft);
  const closing = closeAsked && completes;
  const lines = requestFrom(draft);
  const units = issuingUnits(draft);

  const change = (lineId: number, patch: (d: LineDraft) => LineDraft) =>
    setDraft((prev) => clampDraft({ ...prev, [lineId]: patch(prev[lineId]) }, state));

  const fulfil = useMutation({
    mutationFn: () =>
      api.fulfilOrder(orderId, {
        lines,
        recipient,
        waybill: waybill.trim() || null,
        note: note.trim() || null,
        complete: closing,
      }),
    onSuccess: (result) => {
      invalidateOrderViews(qc, { orderId });
      showToast(t('orders.fulfil.done'));
      onDone?.(result);
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const methodNames = methods.map((m) => m.name);
  if (recipient.delivery_method && !methodNames.includes(recipient.delivery_method)) {
    methodNames.unshift(recipient.delivery_method);
  }
  const canSubmit = (lines.length > 0 || closing) && !fulfil.isPending;

  return (
    <div className="space-y-4">
      {lines.length === 0 && !completes && <p className="text-bambu-gray">{t('orders.fulfil.nothing')}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-bambu-gray">
              <th className="p-2">{t('orders.fulfil.columns.line')}</th>
              <th className="p-2">{t('orders.fulfil.columns.ordered')}</th>
              <th className="p-2">{t('orders.fulfil.columns.assemble')}</th>
              <th className="p-2">{t('orders.fulfil.columns.receive')}</th>
              <th className="p-2">{t('orders.fulfil.columns.held')}</th>
              <th className="p-2">{t('orders.fulfil.columns.issueNow')}</th>
              <th className="p-2">{t('orders.fulfil.columns.issued')}</th>
            </tr>
          </thead>
          <tbody>
            {state.lines.map((line) =>
              line.mode === 'parts' ? (
                <PartsLineRows key={line.line_id} line={line} draft={draft[line.line_id]} onChange={change} />
              ) : (
                <ProductLineRow key={line.line_id} line={line} draft={draft[line.line_id]} onChange={change} />
              ),
            )}
          </tbody>
        </table>
      </div>

      <fieldset className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <legend className="text-sm text-bambu-gray mb-1">{t('orders.fulfil.recipient')}</legend>
        <label className="text-sm space-y-1">
          <span className="text-bambu-gray">{t('orders.fulfil.recipientName')}</span>
          <input
            value={recipient.name ?? ''}
            onChange={(e) => setRecipient({ ...recipient, name: e.target.value || null })}
            aria-label={t('orders.fulfil.recipientName')}
            className={FIELD_CLS}
          />
        </label>
        <label className="text-sm space-y-1">
          <span className="text-bambu-gray">{t('orders.fulfil.phone')}</span>
          <input
            value={recipient.phone ?? ''}
            onChange={(e) => setRecipient({ ...recipient, phone: e.target.value || null })}
            aria-label={t('orders.fulfil.phone')}
            className={FIELD_CLS}
          />
        </label>
        <label className="text-sm space-y-1">
          <span className="text-bambu-gray">{t('orders.fulfil.deliveryMethod')}</span>
          <Select
            value={recipient.delivery_method ?? ''}
            onChange={(e) => setRecipient({ ...recipient, delivery_method: e.target.value || null })}
            aria-label={t('orders.fulfil.deliveryMethod')}
            className="w-full"
          >
            <option value="">{t('orders.fulfil.noMethod')}</option>
            {methodNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm space-y-1">
          <span className="text-bambu-gray">{t('orders.fulfil.deliveryDetails')}</span>
          <input
            value={recipient.delivery_details ?? ''}
            onChange={(e) => setRecipient({ ...recipient, delivery_details: e.target.value || null })}
            aria-label={t('orders.fulfil.deliveryDetails')}
            className={FIELD_CLS}
          />
        </label>
        <label className="text-sm space-y-1">
          <span className="text-bambu-gray">{t('orders.fulfil.waybill')}</span>
          <input
            value={waybill}
            maxLength={WAYBILL_MAX}
            onChange={(e) => setWaybill(e.target.value)}
            aria-label={t('orders.fulfil.waybill')}
            className={FIELD_CLS}
          />
        </label>
        <label className="text-sm space-y-1">
          <span className="text-bambu-gray">{t('orders.fulfil.note')}</span>
          <input
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            aria-label={t('orders.fulfil.note')}
            className={FIELD_CLS}
          />
        </label>
      </fieldset>

      <label className="flex items-center gap-2 text-sm" title={completes ? undefined : t('orders.fulfil.completeHint')}>
        <input
          type="checkbox"
          checked={closing}
          disabled={!completes}
          onChange={(e) => setCloseAsked(e.target.checked)}
          aria-label={t('orders.fulfil.complete')}
        />
        <span className={completes ? 'text-white' : 'text-bambu-gray'}>{t('orders.fulfil.complete')}</span>
        {!completes && <span className="text-xs text-bambu-gray">{t('orders.fulfil.completeHint')}</span>}
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-bambu-dark-tertiary">
        <span className="mr-auto text-sm text-bambu-gray">{t('orders.fulfil.summary', { count: units })}</span>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => fulfil.mutate()} disabled={!canSubmit}>
          {t('orders.fulfil.submit')}
        </Button>
      </div>
    </div>
  );
}

function NumberCell({
  value,
  max,
  label,
  onChange,
}: {
  value: number;
  max: number;
  label: string;
  onChange: (n: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        disabled={max === 0}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className={NUMBER_CLS}
      />
      <span className="text-bambu-gray">{t('orders.fulfil.ofN', { count: max })}</span>
    </div>
  );
}

function ProductLineRow({
  line,
  draft,
  onChange,
}: {
  line: FulfilmentLineState;
  draft: LineDraft;
  onChange: (lineId: number, patch: (d: LineDraft) => LineDraft) => void;
}) {
  const { t } = useTranslation();
  const name = line.product_name;
  return (
    <tr data-testid={`fulfil-line-${line.line_id}`} className="border-t border-bambu-dark-tertiary">
      <td className="p-2 text-white">{name}</td>
      <td className="p-2">{line.ordered}</td>
      <td className="p-2">
        <NumberCell
          value={draft.assemble}
          max={line.can_assemble}
          label={t('orders.fulfil.assembleLabel', { name })}
          onChange={(n) => onChange(line.line_id, (d) => ({ ...d, assemble: n }))}
        />
      </td>
      <td className="p-2">
        <NumberCell
          value={draft.receive}
          max={line.can_receive}
          label={t('orders.fulfil.receiveLabel', { name })}
          onChange={(n) => onChange(line.line_id, (d) => ({ ...d, receive: n }))}
        />
      </td>
      <td className="p-2">{line.held}</td>
      <td className="p-2">
        <NumberCell
          value={draft.issue}
          max={issueCeiling(line, draft)}
          label={t('orders.fulfil.issueLabel', { name })}
          onChange={(n) => onChange(line.line_id, (d) => ({ ...d, issue: n }))}
        />
      </td>
      <td className="p-2 whitespace-nowrap">{t('orders.fulfil.issuedOf', { issued: line.issued, ordered: line.ordered })}</td>
    </tr>
  );
}

function PartsLineRows({
  line,
  draft,
  onChange,
}: {
  line: FulfilmentLineState;
  draft: LineDraft;
  onChange: (lineId: number, patch: (d: LineDraft) => LineDraft) => void;
}) {
  const { t } = useTranslation();
  const setPart = (partId: number, field: 'receive' | 'issue', n: number) =>
    onChange(line.line_id, (d) => ({ ...d, parts: { ...d.parts, [partId]: { ...d.parts[partId], [field]: n } } }));
  return (
    <>
      <tr data-testid={`fulfil-line-${line.line_id}`} className="border-t border-bambu-dark-tertiary">
        <td className="p-2 text-white">
          {line.product_name} <span className="text-xs text-bambu-gray">{t('orders.fulfil.partsLine')}</span>
        </td>
        <td className="p-2">{line.ordered}</td>
        <td className="p-2" />
        <td className="p-2" />
        <td className="p-2">{line.held}</td>
        <td className="p-2" />
        <td className="p-2 whitespace-nowrap">{t('orders.fulfil.issuedOf', { issued: line.issued, ordered: line.ordered })}</td>
      </tr>
      {line.parts.map((part) => {
        const d = draft.parts[part.part_id] ?? { receive: 0, issue: 0 };
        return (
          <tr key={part.part_id} className="text-bambu-gray">
            <td className="p-2 pl-6">{part.name}</td>
            <td className="p-2">{part.wanted}</td>
            <td className="p-2" />
            <td className="p-2">
              <NumberCell
                value={d.receive}
                max={part.can_receive}
                label={t('orders.fulfil.receiveLabel', { name: part.name })}
                onChange={(n) => setPart(part.part_id, 'receive', n)}
              />
            </td>
            <td className="p-2">{part.held}</td>
            <td className="p-2">
              <NumberCell
                value={d.issue}
                max={part.held + d.receive}
                label={t('orders.fulfil.issueLabel', { name: part.name })}
                onChange={(n) => setPart(part.part_id, 'issue', n)}
              />
            </td>
            <td className="p-2 whitespace-nowrap">
              {t('orders.fulfil.issuedOf', { issued: part.issued, ordered: part.wanted })}
            </td>
          </tr>
        );
      })}
    </>
  );
}
