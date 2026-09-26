/**
 * Initials for a user name (spec workshop-order-stage, rule 13): the first
 * letters of the first two words (split on space . _ -), else the first two
 * letters — upper case. Users carry only a `username`, so it is all there is.
 */
export function initialsOf(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '').slice(0, 2);
  return letters.toUpperCase();
}
