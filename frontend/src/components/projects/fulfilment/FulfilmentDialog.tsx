import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, WAYBILL_MAX } from '../../../api/client';
import type { FulfilmentLineState, FulfilmentRecipient, FulfilmentResult, FulfilmentState } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useFulfilment } from '../../../hooks/useFulfilment';
import { invalidateOrderViews } from '../../../utils/queryInvalidation';
import { Button } from '../../Button';
import { Modal } from '../../Modal';
import { RecipientFields } from './RecipientFields';
import {
  clampDraft,
  completesOrder,
  draftFrom,
  issueCeiling,
  issuingUnits,
  requestFrom,
  writingOff,
} from './fulfilmentState';
import type { Draft, FulfilmentMode, LineDraft, PartDraft } from './fulfilmentState';

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
 * «Списати…» opens a column for what broke on the shelf — a note is then required
 * (spec workshop-order-issue-followups, rules 46–48). An order without a customer
 * has no issue column: it closes to stock once everything is received (rules 36–39).
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
  const { data: state, isLoading } = useFulfilment(orderId);
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
  const [typed, setDraft] = useState<Draft>(() => draftFrom(state, mode));
  // Always inside the CURRENT state: after a refusal the state is read again, and what the
  // operator typed is kept only as far as it still fits (final review I2).
  const draft = clampDraft(typed, state);
  const [recipient, setRecipient] = useState<FulfilmentRecipient>(state.recipient);
  const [waybill, setWaybill] = useState('');
  const [note, setNote] = useState('');
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [writeOffNote, setWriteOffNote] = useState('');
  const [closeAsked, setCloseAsked] = useState(completeAsked);
  const [error, setError] = useState<string | null>(null);

  // No customer: nothing is issued, the order closes to stock (followups, rules 35–39).
  const issuing = !state.closes_to_stock;
  const completes = completesOrder(state, draft);
  const closing = closeAsked && completes;
  const lines = requestFrom(draft);
  const units = issuingUnits(draft);
  const writing = writingOff(draft);
  const noteMissing = writing > 0 && writeOffNote.trim() === '';

  const change = (lineId: number, patch: (d: LineDraft) => LineDraft) =>
    setDraft((prev) => {
      const current = clampDraft(prev, state);
      return clampDraft({ ...current, [lineId]: patch(current[lineId]) }, state);
    });

  const fulfil = useMutation({
    mutationFn: () =>
      api.fulfilOrder(orderId, {
        lines,
        recipient,
        waybill: waybill.trim() || null,
        note: note.trim() || null,
        complete: closing,
        write_off_note: writing > 0 ? writeOffNote.trim() : null,
      }),
    onSuccess: (result) => {
      invalidateOrderViews(qc, { orderId });
      showToast(t('orders.fulfil.done'));
      onDone?.(result);
      onClose();
    },
    // The server's sentence, and the numbers read again — the refusal means they moved.
    onError: (err: Error) => {
      setError(err.message);
      void qc.invalidateQueries({ queryKey: ['project-fulfilment', orderId] });
    },
  });

  const canSubmit = (lines.length > 0 || closing) && !noteMissing && !fulfil.isPending;
  const completeLabel = t(issuing ? 'orders.fulfil.complete' : 'orders.fulfil.completeToStock');
  const completeHint = t(issuing ? 'orders.fulfil.completeHint' : 'orders.fulfil.completeToStockHint');

  return (
    <div className="space-y-4">
      {lines.length === 0 && !completes && <p className="text-bambu-gray">{t('orders.fulfil.nothing')}</p>}
      {!issuing && <p className="text-sm text-bambu-gray">{t('orders.fulfil.noCustomer')}</p>}
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => setWriteOffOpen((open) => !open)}>
          {t('orders.fulfil.writeOffToggle')}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-bambu-gray">
              <th className="p-2">{t('orders.fulfil.columns.line')}</th>
              <th className="p-2">{t('orders.fulfil.columns.ordered')}</th>
              <th className="p-2">{t('orders.fulfil.columns.assemble')}</th>
              <th className="p-2">{t('orders.fulfil.columns.receive')}</th>
              <th className="p-2">{t('orders.fulfil.columns.held')}</th>
              {writeOffOpen && <th className="p-2">{t('orders.fulfil.columns.writeOff')}</th>}
              {issuing && <th className="p-2">{t('orders.fulfil.columns.issueNow')}</th>}
              <th className="p-2">{t('orders.fulfil.columns.issued')}</th>
            </tr>
          </thead>
          <tbody>
            {state.lines.map((line) =>
              line.mode === 'parts' ? (
                <PartsLineRows
                  key={line.line_id}
                  line={line}
                  draft={draft[line.line_id]}
                  onChange={change}
                  writeOffOpen={writeOffOpen}
                  issuing={issuing}
                />
              ) : (
                <ProductLineRow
                  key={line.line_id}
                  line={line}
                  draft={draft[line.line_id]}
                  onChange={change}
                  writeOffOpen={writeOffOpen}
                  issuing={issuing}
                />
              ),
            )}
          </tbody>
        </table>
      </div>

      {writeOffOpen && (
        <label className="block text-sm space-y-1">
          <span className="text-bambu-gray">{t('orders.fulfil.writeOffNote')}</span>
          <input
            value={writeOffNote}
            maxLength={2000}
            onChange={(e) => setWriteOffNote(e.target.value)}
            aria-label={t('orders.fulfil.writeOffNote')}
            aria-invalid={noteMissing}
            className={FIELD_CLS}
          />
        </label>
      )}

      {issuing && (
        <fieldset className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <legend className="text-sm text-bambu-gray mb-1">{t('orders.fulfil.recipient')}</legend>
          <RecipientFields value={recipient} onChange={setRecipient} />
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
      )}

      <label className="flex items-center gap-2 text-sm" title={completes ? undefined : completeHint}>
        <input
          type="checkbox"
          checked={closing}
          disabled={!completes}
          onChange={(e) => setCloseAsked(e.target.checked)}
          aria-label={completeLabel}
        />
        <span className={completes ? 'text-white' : 'text-bambu-gray'}>{completeLabel}</span>
        {!completes && <span className="text-xs text-bambu-gray">{completeHint}</span>}
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-bambu-dark-tertiary">
        <span className="mr-auto text-sm text-bambu-gray">
          {issuing && t('orders.fulfil.summary', { count: units })}
        </span>
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
  writeOffOpen,
  issuing,
}: {
  line: FulfilmentLineState;
  draft: LineDraft;
  onChange: (lineId: number, patch: (d: LineDraft) => LineDraft) => void;
  writeOffOpen: boolean;
  issuing: boolean;
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
      {writeOffOpen && (
        <td className="p-2">
          <NumberCell
            value={draft.writeOff}
            max={line.held + draft.assemble + draft.receive}
            label={t('orders.fulfil.writeOffLabel', { name })}
            onChange={(n) => onChange(line.line_id, (d) => ({ ...d, writeOff: n }))}
          />
        </td>
      )}
      {issuing && (
        <td className="p-2">
          <NumberCell
            value={draft.issue}
            max={issueCeiling(line, draft)}
            label={t('orders.fulfil.issueLabel', { name })}
            onChange={(n) => onChange(line.line_id, (d) => ({ ...d, issue: n }))}
          />
        </td>
      )}
      <td className="p-2 whitespace-nowrap">{t('orders.fulfil.issuedOf', { issued: line.issued, ordered: line.ordered })}</td>
    </tr>
  );
}

function PartsLineRows({
  line,
  draft,
  onChange,
  writeOffOpen,
  issuing,
}: {
  line: FulfilmentLineState;
  draft: LineDraft;
  onChange: (lineId: number, patch: (d: LineDraft) => LineDraft) => void;
  writeOffOpen: boolean;
  issuing: boolean;
}) {
  const { t } = useTranslation();
  const setPart = (partId: number, field: keyof PartDraft, n: number) =>
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
        {writeOffOpen && <td className="p-2" />}
        {issuing && <td className="p-2" />}
        <td className="p-2 whitespace-nowrap">{t('orders.fulfil.issuedOf', { issued: line.issued, ordered: line.ordered })}</td>
      </tr>
      {line.parts.map((part) => {
        const d = draft.parts[part.part_id] ?? { receive: 0, writeOff: 0, issue: 0 };
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
            {writeOffOpen && (
              <td className="p-2">
                <NumberCell
                  value={d.writeOff}
                  max={part.held + d.receive}
                  label={t('orders.fulfil.writeOffLabel', { name: part.name })}
                  onChange={(n) => setPart(part.part_id, 'writeOff', n)}
                />
              </td>
            )}
            {issuing && (
              <td className="p-2">
                <NumberCell
                  value={d.issue}
                  max={part.held + d.receive - d.writeOff}
                  label={t('orders.fulfil.issueLabel', { name: part.name })}
                  onChange={(n) => setPart(part.part_id, 'issue', n)}
                />
              </td>
            )}
            <td className="p-2 whitespace-nowrap">
              {t('orders.fulfil.issuedOf', { issued: part.issued, ordered: part.wanted })}
            </td>
          </tr>
        );
      })}
    </>
  );
}
