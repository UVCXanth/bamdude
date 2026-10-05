/**
 * One rule for putting places in order: by name, the way a person reads names.
 *
 * The default `Array.prototype.sort()` compares UTF-16 code units, which is not
 * the Ukrainian alphabet: Ґ, Є, І and Ї live outside the А–Я block and land
 * *before* А, and every lowercase name lands after every uppercase one. On a
 * farm with places called "Ірпінь" and "Ангар" that reads as no order at all.
 *
 * Pin the collation to Ukrainian so І sorts before Ї on every host, including
 * English-locale CI and browsers. `numeric` also puts "Цех 2" before "Цех 10".
 */
const locationCollator = new Intl.Collator('uk', { sensitivity: 'base', numeric: true });

export function compareLocationNames(a: string, b: string): number {
  return locationCollator.compare(a, b);
}

/** The same rule for whatever carries a name — a location row, a printer, a queue. */
export function byLocationName<T>(name: (item: T) => string | null | undefined) {
  return (a: T, b: T) => compareLocationNames(name(a) || '', name(b) || '');
}
