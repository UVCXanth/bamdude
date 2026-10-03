import { customerInitials } from './customerInitials';

const SIZE = {
  // `.w-customer-avatar` of the mockup: 40 × 40, radius 10, 14 px.
  md: 'w-10 h-10 text-sm',
  // `.w-customer-avatar.large`: 64 × 64, 22 px.
  lg: 'w-16 h-16 text-[22px]',
} as const;

/**
 * The customer's initials on the accent's tint (WS-13 E11 J) — in a table row, on a
 * card and, large, on the customer's page. Decoration: the name always stands beside it.
 */
export function CustomerAvatar({ name, size = 'md' }: { name: string; size?: keyof typeof SIZE }) {
  return (
    <span
      aria-hidden="true"
      className={`${SIZE[size]} flex-shrink-0 grid place-items-center rounded-[10px] font-semibold bg-bambu-green/15 text-bambu-green`}
    >
      {customerInitials(name)}
    </span>
  );
}
