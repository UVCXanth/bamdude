import type { ComponentProps } from 'react';
import { Link } from 'react-router';
import { useCanOpen } from '../../hooks/useCanOpen';

type SectionLinkProps = ComponentProps<typeof Link> & { to: string };

/**
 * A link into a Workshop section for whoever may read it, its text for anyone else (WS-13 E13
 * O19): a section's route sends a reader without its read back to «/» without a word, so a link
 * there would be a door that only bounces — the storekeeper's product, an orders reader's
 * customer. The text keeps the link's look minus the pointer, as the archive's order chip does.
 */
export function SectionLink({ to, children, className, ...rest }: SectionLinkProps) {
  const canOpen = useCanOpen();
  if (canOpen(to)) {
    return (
      <Link to={to} className={className} {...rest}>
        {children}
      </Link>
    );
  }
  const plain = (typeof className === 'string' ? className : '')
    .split(/\s+/)
    .filter((c) => c && !c.startsWith('hover:') && c !== 'text-bambu-green')
    .join(' ');
  // What names the element — its test hooks, id and title — stays; what a link does goes.
  const kept = Object.fromEntries(Object.entries(rest).filter(([k]) => k.startsWith('data-') || k === 'id' || k === 'title'));
  return (
    <span className={plain || undefined} {...kept}>
      {children}
    </span>
  );
}
