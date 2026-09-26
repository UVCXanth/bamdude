import { initialsOf } from '../../utils/initials';

/** Who is responsible for an order: initials in a circle, then the name; a dash for nobody. */
export function ResponsibleName({ name, className = '' }: { name: string | null; className?: string }) {
  if (!name) return <span className={`text-bambu-gray ${className}`}>—</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span
        aria-hidden
        className="w-6 h-6 rounded-full bg-bambu-dark-tertiary text-bambu-gray text-[10px] font-semibold flex items-center justify-center"
      >
        {initialsOf(name)}
      </span>
      <span>{name}</span>
    </span>
  );
}
