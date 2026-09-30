import { useState } from 'react';

/**
 * A count typed as text (WS-13 E5 C05, D06): a whole number in range is taken as it
 * is typed; an empty or broken field goes back to the last good number when it is
 * left — so retyping never passes through a clamped minimum (the E4 I1 lesson).
 *
 * The typed text belongs to the value it was typed against: when the value changes
 * from outside (a reset, a server answer), the field shows the new value.
 */
export function CountInput({
  id,
  value,
  min,
  max,
  disabled = false,
  onCommit,
  ariaLabel,
  className,
}: {
  id?: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
  ariaLabel: string;
  className?: string;
}) {
  const [buffer, setBuffer] = useState<{ text: string; base: number } | null>(null);
  const parse = (raw: string) => {
    const n = Number(raw);
    return raw.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      value={buffer && buffer.base === value ? buffer.text : String(value)}
      disabled={disabled}
      onChange={(e) => {
        const n = parse(e.target.value);
        setBuffer({ text: e.target.value, base: n ?? value });
        if (n != null) onCommit(n);
      }}
      onBlur={() => setBuffer(null)}
      aria-label={ariaLabel}
      className={
        className ??
        'w-[88px] rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-white disabled:opacity-50'
      }
    />
  );
}
