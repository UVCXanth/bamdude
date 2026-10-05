import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CardSizeSwitch } from '../../components/CardSizeSwitch';

it('keeps a disabled size out of keyboard and pointer activation', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<CardSizeSwitch value={1} onChange={onChange} disabled fullWidth />);
  expect(screen.getByRole('group')).toHaveClass('w-full');
  const buttons = screen.getAllByRole('button');
  expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
  expect(buttons.every((button) => button.hasAttribute('disabled'))).toBe(true);
  await user.tab();
  expect(buttons).not.toContain(document.activeElement);
  await user.click(buttons[1]);
  buttons[1].focus();
  await user.keyboard('{Enter} ');
  expect(onChange).not.toHaveBeenCalled();
});

it('offers keyboard choice again with the same size after being enabled', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(<CardSizeSwitch value={2} onChange={onChange} disabled />);
  rerender(<CardSizeSwitch value={2} onChange={onChange} />);
  const buttons = screen.getAllByRole('button');
  expect(buttons[1]).toHaveAttribute('aria-pressed', 'true');
  expect(buttons[1]).toHaveClass('bg-bambu-green');
  await user.tab();
  expect(buttons[0]).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(onChange).toHaveBeenCalledWith(1);
});
