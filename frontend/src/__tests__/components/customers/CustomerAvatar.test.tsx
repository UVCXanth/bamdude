/**
 * The customer's avatar (WS-13 E11 J): the initials by the mockup's rule — quotes
 * dropped, the first letters of the first two words, upper case — at 40 px in a row
 * and 64 px on the customer's page. Decoration: the name stands beside it.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CustomerAvatar } from '../../../components/customers/CustomerAvatar';
import { customerInitials } from '../../../components/customers/customerInitials';

describe('customerInitials', () => {
  it('takes the first letters of the first two words, upper-cased', () => {
    expect(customerInitials('Архітект бюро')).toBe('АБ');
    expect(customerInitials('ЕлектроСервіс')).toBe('Е');
    expect(customerInitials('Наука дітям Київ')).toBe('НД');
  });

  it('drops the quotes and apostrophes the mockup drops', () => {
    expect(customerInitials('Кав’ярня «Зерно»')).toBe('КЗ');
    expect(customerInitials('"Acme" \'west\'')).toBe('AW');
  });

  it('a name with nothing to take gives no initials', () => {
    expect(customerInitials('  «»  ')).toBe('');
  });
});

describe('CustomerAvatar', () => {
  it('is decoration with the initials, 40 px by default and 64 px large', () => {
    const { container, rerender } = render(<CustomerAvatar name="Світло Про" />);
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
    expect(avatar).toHaveTextContent('СП');
    expect(avatar).toHaveClass('w-10', 'h-10');
    rerender(<CustomerAvatar name="Світло Про" size="lg" />);
    expect(container.firstElementChild).toHaveClass('w-16', 'h-16');
  });
});
