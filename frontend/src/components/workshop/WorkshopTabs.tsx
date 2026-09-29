import { useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface WorkshopTabItem<V extends string> {
  /** Stable — it is what `onChange` answers with and what the ids are built from. */
  value: V;
  label: ReactNode;
  /**
   * A figure the SERVER returned (`0` included), `null` for one that was asked
   * for and is not known yet, absent for a tab that has no count at all. An
   * unknown is never shown as a zero (WS-13 E2 C05).
   */
  count?: number | null;
  disabled?: boolean;
}

/** The id of a strip's tab — the panel's `aria-labelledby` points at it. */
function workshopTabId(idBase: string, value: string): string {
  return `${idBase}-tab-${value}`;
}

/** The id of a strip's panel — the tab's `aria-controls` points at it. */
function workshopTabPanelId(idBase: string, value: string): string {
  return `${idBase}-panel-${value}`;
}

interface WorkshopTabsProps<V extends string> {
  /** Unique on the screen (the page's `useId()`), shared with its `WorkshopTabPanel`. */
  idBase: string;
  ariaLabel: string;
  value: V;
  items: readonly WorkshopTabItem<V>[];
  onChange: (value: V) => void;
  /** `filter` — a list's status strip (8×16); `detail` — a page's or a picker's sections (8×14). */
  size?: 'filter' | 'detail';
  /** The counts on screen belong to the previous filters — the page is fetching the new ones. */
  busy?: boolean;
  /** Which panels exist in the DOM: only the active one (the usual), or all of them. A tab
   *  never points `aria-controls` at a panel that is not there. */
  panels?: 'active' | 'all';
}

/**
 * Underline tabs of the Workshop (WS-13 E2 §C).
 *
 * ⚠️ **Controlled, and nothing else.** The strip reads no URL, writes no URL and
 * starts no request: it tells the page which tab was asked for (`onChange`) and
 * the page decides what that means — Orders resets its page and keeps its other
 * filters, Stock opens the new tab on a clean URL. Folding either policy in here
 * would make the other page wrong.
 *
 * ⚠️ **Manual activation.** The arrows, Home and End only MOVE focus (skipping a
 * disabled tab, wrapping round); Enter, Space or a click activates. An arrow
 * that activated would fire a request — and a URL write — per key press.
 *
 * ⚠️ **One Tab stop, and it follows the focus while the focus is inside.** Coming
 * into the strip lands on the selected tab; once the arrows have moved the focus,
 * the focused tab is the stop, so Tab and Shift+Tab leave the strip from where the
 * focus is (E2-V01: tied to the selection, Tab after Home went back to the
 * selected tab further down the same strip). Leaving the strip — or a value
 * changed from outside — puts the stop back on the selection, without taking the
 * focus from wherever it is.
 */
export function WorkshopTabs<V extends string>({
  idBase,
  ariaLabel,
  value,
  items,
  onChange,
  size = 'filter',
  busy = false,
  panels = 'active',
}: WorkshopTabsProps<V>) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const tabs = useRef(new Map<V, HTMLButtonElement>());
  // Where the arrows left the focus, remembered FOR a selection: once the value
  // changes, the remembered stop no longer applies and the selection is the stop.
  const [roving, setRoving] = useState<{ at: V; forValue: V } | null>(null);
  const movable = (v: V) => items.some((item) => item.value === v && !item.disabled);
  const stop = roving && roving.forValue === value && movable(roving.at) ? roving.at : value;

  /** Focus a tab and bring it into the strip's own view — the strip scrolls, the page never does. */
  const focusTab = (target: V) => {
    const el = tabs.current.get(target);
    if (!el) return;
    el.focus({ preventScroll: true });
    const box = scroller.current;
    if (!box) return;
    if (el.offsetLeft < box.scrollLeft) box.scrollLeft = el.offsetLeft;
    else if (el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) {
      box.scrollLeft = el.offsetLeft + el.offsetWidth - box.clientWidth;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.filter((item) => !item.disabled);
    const at = enabled.findIndex((item) => tabs.current.get(item.value) === document.activeElement);
    if (at === -1 || enabled.length === 0) return;
    const n = enabled.length;
    const next =
      e.key === 'ArrowRight'
        ? enabled[(at + 1) % n]
        : e.key === 'ArrowLeft'
          ? enabled[(at - 1 + n) % n]
          : e.key === 'Home'
            ? enabled[0]
            : e.key === 'End'
              ? enabled[n - 1]
              : undefined;
    if (!next) return;
    e.preventDefault();
    setRoving({ at: next.value, forValue: value });
    focusTab(next.value);
  };

  // The focus left the strip: the next entry is on the selected tab again.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRoving(null);
  };

  const pad = size === 'filter' ? 'px-4 py-2' : 'px-3.5 py-2';

  return (
    <div
      ref={scroller}
      role="tablist"
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      // The strip's line is an INSET shadow, not a border the tabs overlap with a
      // negative margin: a horizontally scrolling box clips anything that hangs
      // out of it, the underline included.
      className="scrollbar-hide relative flex min-w-0 max-w-full gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-bambu-dark-tertiary)]"
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              if (el) tabs.current.set(item.value, el);
              else tabs.current.delete(item.value);
            }}
            type="button"
            role="tab"
            id={workshopTabId(idBase, item.value)}
            aria-selected={selected}
            aria-controls={selected || panels === 'all' ? workshopTabPanelId(idBase, item.value) : undefined}
            tabIndex={item.value === stop ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            className={`shrink-0 whitespace-nowrap rounded-none border-b-2 bg-transparent text-sm font-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green disabled:cursor-not-allowed disabled:opacity-40 ${pad} ${
              selected ? 'border-bambu-green text-white' : 'border-transparent text-bambu-gray hover:text-white'
            }`}
          >
            {item.label}
            {item.count === null ? (
              <>
                <span aria-hidden="true"> (—)</span>
                <span className="sr-only">, {t('list.tabs.countLoading')}</span>
              </>
            ) : item.count !== undefined ? (
              <span className={busy ? 'opacity-60' : undefined}> ({item.count})</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a `WorkshopTabs` strip controls — mount it for the active value (or for each, with `panels="all"`). */
export function WorkshopTabPanel<V extends string>({
  idBase,
  value,
  className,
  hidden,
  children,
}: {
  idBase: string;
  value: V;
  className?: string;
  /** A panel kept mounted while another is shown (`panels="all"`) — its drafts live on. */
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={workshopTabPanelId(idBase, value)}
      aria-labelledby={workshopTabId(idBase, value)}
      className={className}
      hidden={hidden}
    >
      {children}
    </div>
  );
}
