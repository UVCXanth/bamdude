/**
 * The Workshop's underline tabs (WS-13 E2 §C): a controlled strip that owns no
 * URL, no query and no data — it tells the page which tab was asked for, and
 * nothing else. What it must get right on its own is the tab pattern itself:
 * one focusable tab, arrows that only MOVE focus (manual activation — an arrow
 * must never start a request or write the URL), panel relations that point at
 * a panel that exists, and counts that never pass an unknown off as a zero.
 */

import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { WorkshopTabPanel, WorkshopTabs, type WorkshopTabItem } from '../../../components/workshop/WorkshopTabs';

type Key = 'active' | 'completed' | 'cancelled' | 'all';

const items: WorkshopTabItem<Key>[] = [
  { value: 'active', label: 'Active', count: 3 },
  { value: 'completed', label: 'Completed', count: 0 },
  { value: 'cancelled', label: 'Cancelled', disabled: true },
  { value: 'all', label: 'All', count: null },
];

function Harness({
  onChange = () => {},
  initial = 'active',
  idBase = 'orders',
}: {
  onChange?: (next: Key) => void;
  initial?: Key;
  idBase?: string;
}) {
  const [value, setValue] = useState<Key>(initial);
  return (
    <>
      <WorkshopTabs
        idBase={idBase}
        ariaLabel="Order status"
        value={value}
        items={items}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
      <WorkshopTabPanel idBase={idBase} value={value}>
        panel of {value}
      </WorkshopTabPanel>
    </>
  );
}

const tab = (name: RegExp) => screen.getByRole('tab', { name });

describe('WorkshopTabs', () => {
  it('is a named tablist whose active tab controls the one mounted panel', () => {
    render(<Harness />);

    const list = screen.getByRole('tablist', { name: 'Order status' });
    expect(within(list).getAllByRole('tab')).toHaveLength(4);
    const active = tab(/Active/);
    expect(active).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(active.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', active.id);
    // Only the active panel is mounted — the others must not point at nothing.
    expect(tab(/Completed/)).not.toHaveAttribute('aria-controls');
    expect(tab(/Completed/)).toHaveAttribute('aria-selected', 'false');
  });

  it('gives two strips on one screen ids of their own', () => {
    render(
      <>
        <Harness idBase="a" />
        <Harness idBase="b" />
      </>,
    );

    const ids = screen.getAllByRole('tab').map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const panels = screen.getAllByRole('tabpanel').map((p) => p.id);
    expect(new Set(panels).size).toBe(2);
  });

  it('puts exactly one tab in the Tab order — the selected one', () => {
    render(<Harness />);

    expect(screen.getAllByRole('tab').filter((t) => t.tabIndex === 0)).toEqual([tab(/Active/)]);
  });

  it('moves focus with the arrows, Home and End, skipping a disabled tab, and activates nothing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    tab(/Active/).focus();

    await user.keyboard('{ArrowRight}');
    expect(tab(/Completed/)).toHaveFocus();
    // «Cancelled» is disabled: the next stop is «All».
    await user.keyboard('{ArrowRight}');
    expect(tab(/All/)).toHaveFocus();
    // …and round again to the first.
    await user.keyboard('{ArrowRight}');
    expect(tab(/Active/)).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(tab(/All/)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab(/Active/)).toHaveFocus();
    await user.keyboard('{End}');
    expect(tab(/All/)).toHaveFocus();

    // Manual activation: focus moved four times, the page was told nothing.
    expect(onChange).not.toHaveBeenCalled();
    expect(tab(/Active/)).toHaveAttribute('aria-selected', 'true');
  });

  it('activates the focused tab on Enter, on Space and on a click — once, and never a disabled one', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    tab(/Active/).focus();

    await user.keyboard('{ArrowRight}{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('completed');
    expect(tab(/Completed/)).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight} ');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith('all');

    fireEvent.click(tab(/Active/));
    expect(onChange).toHaveBeenLastCalledWith('active');

    fireEvent.click(tab(/Cancelled/));
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('follows a value changed from outside without taking the focus', () => {
    function Outside() {
      const [value, setValue] = useState<Key>('active');
      return (
        <>
          <button type="button" onClick={() => setValue('completed')}>
            elsewhere
          </button>
          <WorkshopTabs idBase="x" ariaLabel="Order status" value={value} items={items} onChange={setValue} />
        </>
      );
    }
    render(<Outside />);
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    elsewhere.focus();

    fireEvent.click(elsewhere);

    expect(tab(/Completed/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/Completed/).tabIndex).toBe(0);
    expect(elsewhere).toHaveFocus();
  });

  it('shows a zero as a zero, and an unknown count as a dash that says it is loading', () => {
    render(<Harness />);

    expect(tab(/Completed/)).toHaveTextContent('Completed (0)');
    expect(tab(/All/)).toHaveTextContent('All (—)');
    expect(tab(/All/)).not.toHaveTextContent('(0)');
    expect(within(tab(/All/)).getByText(/loading/i)).toBeInTheDocument();
    // A tab with no count at all says nothing in brackets.
    expect(tab(/Cancelled/)).toHaveTextContent(/^Cancelled$/);
  });

  it('marks the strip busy while its counts belong to the previous filters', () => {
    render(
      <WorkshopTabs idBase="b" ariaLabel="Order status" value="active" items={items} onChange={() => {}} busy />,
    );

    expect(screen.getByRole('tablist')).toHaveAttribute('aria-busy', 'true');
  });
});
