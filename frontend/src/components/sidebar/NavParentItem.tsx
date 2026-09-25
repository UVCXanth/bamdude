import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType, LiHTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { useHoverIntent } from '../../hooks/useHoverIntent';
import { useNavOpenState } from '../../hooks/useNavOpenState';
import { activeChildId, type NavBadgeKind, type NavChild } from './navChildren';

export interface NavParentItemProps {
  item: { id: string; icon: ComponentType<{ className?: string }>; labelKey: string; children: readonly NavChild[] };
  /** The sidebar shows text (expanded, or the compact drawer); false = the icon rail. */
  expanded: boolean;
  showGrip: boolean;
  badges: Partial<Record<NavBadgeKind, number>>;
  /** Drag handlers and the drop-indicator class from Layout — the parent drags as one entry. */
  liProps: LiHTMLAttributes<HTMLLIElement>;
}

function NavCount({ kind, count, onAccent }: { kind: NavBadgeKind; count: number; onAccent: boolean }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <span
      title={t(`nav.badge.${kind}`)}
      className={`min-w-[22px] h-5 px-1.5 inline-flex items-center justify-center rounded-md text-[11px] font-bold tabular-nums ${
        onAccent ? 'bg-white/20 text-white' : 'bg-bambu-green/20 text-bambu-green'
      }`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** The children as links; `onNavigate` lets the flyout close itself. */
export function NavChildLinks({
  entries,
  activeId,
  badges,
  onNavigate,
}: {
  entries: readonly NavChild[];
  activeId: string | null;
  badges: Partial<Record<NavBadgeKind, number>>;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {entries.map((child) => {
        const active = child.id === activeId;
        return (
          <li key={child.id}>
            {/* A plain Link: NavLink's own prefix match cannot know our `match`. */}
            <Link
              to={child.to}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                active ? 'bg-bambu-green text-white' : 'text-bambu-gray-light hover:bg-bambu-dark-tertiary hover:text-white'
              }`}
            >
              <span>{t(child.labelKey)}</span>
              {child.badge && <NavCount kind={child.badge} count={badges[child.badge] ?? 0} onAccent={active} />}
            </Link>
          </li>
        );
      })}
    </>
  );
}

/**
 * The parent on the collapsed icon rail (spec workshop-nav, rule 4): its
 * children open in a flyout beside the icon — on hover (closing a moment after
 * the pointer leaves, so it can cross the gap), on a click (touch), or with
 * Enter/Space, which also moves the focus to the first child. A plain Tab onto
 * the icon does not open it.
 */
function RailParent({
  item,
  badges,
  liProps,
  activeId,
  hasCount,
  dot,
}: {
  item: NavParentItemProps['item'];
  badges: NavParentItemProps['badges'];
  liProps: NavParentItemProps['liProps'];
  activeId: string | null;
  hasCount: boolean;
  dot: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const iconRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const focusFirstRef = useRef(false);
  const Icon = item.icon;
  const inside = activeId !== null;

  // Placed from the icon at the moment it opens; the rail does not move under
  // an open flyout, and a resize closes it.
  const setFlyoutOpen = useCallback((next: boolean) => {
    if (next && iconRef.current) {
      const r = iconRef.current.getBoundingClientRect();
      setPos({ top: r.top - 6, left: r.right + 6 });
    }
    setOpen(next);
  }, []);
  const hover = useHoverIntent(setFlyoutOpen);

  useEffect(() => {
    if (!open) return;
    if (focusFirstRef.current) {
      focusFirstRef.current = false;
      flyoutRef.current?.querySelector<HTMLElement>('a')?.focus();
    }
    // An inner layer's Escape lives on `document` and stops there (modal-stack
    // rule); it is registered only while open, so a closed flyout never eats it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      iconRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (flyoutRef.current?.contains(target) || iconRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  return (
    <li {...liProps}>
      <button
        ref={iconRef}
        type="button"
        aria-label={t(item.labelKey)}
        title={t(item.labelKey)}
        aria-expanded={open}
        data-inside={inside}
        onMouseEnter={hover.enter}
        onMouseLeave={hover.leave}
        onClick={() => setFlyoutOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            // preventDefault: the button's own activation would fire onClick and toggle it shut again.
            e.preventDefault();
            focusFirstRef.current = true;
            setFlyoutOpen(true);
          }
        }}
        // Firefox activates a button on Space's keyup, not its keydown.
        onKeyUp={(e) => {
          if (e.key === ' ') e.preventDefault();
        }}
        className={`w-full flex items-center justify-center px-2 py-1.5 rounded-lg transition-colors ${
          inside ? 'bg-bambu-green text-white' : 'text-bambu-gray-light hover:bg-bambu-dark-tertiary hover:text-white'
        }`}
      >
        <span className="relative">
          <Icon className="w-5 h-5 flex-shrink-0" />
          {hasCount && dot}
        </span>
      </button>
      {open &&
        createPortal(
          // Portalled: the sidebar's list scrolls and would clip it. z-[49] keeps it
          // under the modal layer (inv-modals-close-only-by-buttons-or-esc).
          <div
            ref={flyoutRef}
            data-testid={`nav-flyout-${item.id}`}
            style={{ position: 'fixed', top: pos.top, left: pos.left }}
            className="z-[49] min-w-[220px] p-1.5 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl shadow-xl"
            onMouseEnter={hover.enter}
            onMouseLeave={hover.leave}
            onBlur={(e) => {
              // Only a focus that moved to a real element outside closes it: a click
              // on the non-focusable heading blurs a link with no relatedTarget.
              const next = e.relatedTarget as Node | null;
              if (!next || flyoutRef.current?.contains(next) || iconRef.current?.contains(next)) return;
              setOpen(false);
            }}
          >
            <nav aria-label={t(item.labelKey)}>
              <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider text-bambu-gray font-medium">
                {t(item.labelKey)}
              </div>
              <ul className="space-y-0.5">
                <NavChildLinks entries={item.children} activeId={activeId} badges={badges} onNavigate={() => setOpen(false)} />
              </ul>
            </nav>
          </div>,
          document.body,
        )}
    </li>
  );
}

/**
 * A sidebar entry with children (spec workshop-nav, rules 1–5). Expanded: a
 * toggle over its children on a dashed guide line. Rail: an icon button whose
 * children open in a flyout. The parent drags as one entry (`liProps`).
 */
export function NavParentItem({ item, expanded, showGrip, badges, liProps }: NavParentItemProps) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [open, setOpen] = useNavOpenState(item.id);
  const activeId = activeChildId(item.children, pathname);
  const inside = activeId !== null;
  const hasCount = item.children.some((child) => child.badge && (badges[child.badge] ?? 0) > 0);
  const Icon = item.icon;
  const dot: ReactNode = (
    <span
      data-testid={`nav-dot-${item.id}`}
      className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-bambu-green rounded-full border-2 border-bambu-dark-secondary"
    />
  );

  if (!expanded) {
    return <RailParent item={item} badges={badges} liProps={liProps} activeId={activeId} hasCount={hasCount} dot={dot} />;
  }

  const folded = !open;
  return (
    <li {...liProps}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-inside={inside}
        className={`w-full flex items-center gap-3 px-4 py-1.5 rounded-lg transition-colors group ${
          folded && inside
            ? 'bg-bambu-green text-white'
            : inside
              ? 'text-white hover:bg-bambu-dark-tertiary'
              : 'text-bambu-gray-light hover:bg-bambu-dark-tertiary hover:text-white'
        }`}
      >
        {showGrip && (
          <GripVertical className="w-4 h-4 flex-shrink-0 opacity-0 group-hover:opacity-50 cursor-grab active:cursor-grabbing -ml-1" />
        )}
        <span className="relative">
          <Icon className="w-5 h-5 flex-shrink-0" />
          {folded && hasCount && dot}
        </span>
        <span className="flex-1 text-left">{t(item.labelKey)}</span>
        {open ? <ChevronUp className="w-4 h-4" aria-hidden /> : <ChevronDown className="w-4 h-4" aria-hidden />}
      </button>
      {open && (
        <ul className="mt-1 mb-0.5 ml-[1.6rem] pl-3 border-l border-dashed border-bambu-gray/40 space-y-0.5">
          <NavChildLinks entries={item.children} activeId={activeId} badges={badges} />
        </ul>
      )}
    </li>
  );
}
