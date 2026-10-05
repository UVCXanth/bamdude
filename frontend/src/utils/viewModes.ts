/** Keep the saved preference separate from a temporarily unavailable view. */
export function shownView<V extends string>(
  preferred: V,
  isAvailable: (mode: V) => boolean,
  fallback: V,
): V {
  return isAvailable(preferred) ? preferred : fallback;
}
