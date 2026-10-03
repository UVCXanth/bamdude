/**
 * A customer's initials by the mockup's rule (`customers.js` `initials`, WS-13 E11 J):
 * the quotes and apostrophes dropped, the first letter of each of the first two words,
 * upper-cased. A letter is a code point, so a name that starts with an emoji does not
 * hand half a surrogate pair to the avatar.
 */
export function customerInitials(name: string): string {
  return name
    .replace(/[«»"’']/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join('')
    .toUpperCase();
}
