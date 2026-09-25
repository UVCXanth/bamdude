import type { ComponentType, LiHTMLAttributes, ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
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
    return (
      <li {...liProps}>
        <button
          type="button"
          aria-label={t(item.labelKey)}
          title={t(item.labelKey)}
          data-inside={inside}
          className={`w-full flex items-center justify-center px-2 py-1.5 rounded-lg transition-colors ${
            inside ? 'bg-bambu-green text-white' : 'text-bambu-gray-light hover:bg-bambu-dark-tertiary hover:text-white'
          }`}
        >
          <span className="relative">
            <Icon className="w-5 h-5 flex-shrink-0" />
            {hasCount && dot}
          </span>
        </button>
      </li>
    );
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
