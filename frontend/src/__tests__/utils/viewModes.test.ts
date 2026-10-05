import { expect, it } from 'vitest';
import { shownView } from '../../utils/viewModes';

it('shows an unavailable preference through a fallback without changing it', () => {
  const preferred = 'camwall' as const;
  expect(shownView(preferred, () => false, 'cards')).toBe('cards');
  expect(preferred).toBe('camwall');
  expect(shownView(preferred, () => true, 'cards')).toBe('camwall');
});
