/**
 * The UI's copy of the server's filing policy (WS-13 E13 O21) — one function per action,
 * so no button composes the rule itself. The server stays the final word.
 */
import { describe, it, expect } from 'vitest';
import type { Permission } from '../../api/client';
import { canFileArchive, canFileFuturePrint, keepsOrderOnCopy } from '../../utils/workshopRights';

const holding = (...granted: string[]) => (p: Permission) => granted.includes(p);
const own = (_r: string, _a: string, createdById: number | null | undefined) => createdById === 5;

describe('canFileFuturePrint — Fф: work this request creates under an order', () => {
  it.each([
    [['orders:file_prints'], true],
    [['orders:update'], true],
    [['orders:read', 'queue:create'], false],
  ])('%j → %s', (granted, expected) => {
    expect(canFileFuturePrint(holding(...granted))).toBe(expected);
  });
});

describe('canFileArchive — F(print): a past print', () => {
  it('the filing right alone reaches anybody’s print, an ownerless one too', () => {
    expect(canFileArchive(holding('orders:file_prints'), () => false, 9)).toBe(true);
    expect(canFileArchive(holding('orders:file_prints'), () => false, null)).toBe(true);
  });

  it('the orders right reaches a print the archive right reaches', () => {
    expect(canFileArchive(holding('orders:update'), own, 5)).toBe(true);
    expect(canFileArchive(holding('orders:update'), own, 9)).toBe(false);
  });

  it('the archive right alone files nothing', () => {
    expect(canFileArchive(holding('archives:update_all'), () => true, 9)).toBe(false);
  });
});

describe('keepsOrderOnCopy — a reprint, a clone or a repeat inherits the order only with Fф', () => {
  it('nothing to inherit keeps nothing', () => {
    expect(keepsOrderOnCopy(null, holding())).toBe(true);
  });

  it('an order is kept by whoever may file work under it, and dropped — explicitly — otherwise', () => {
    expect(keepsOrderOnCopy(4, holding('orders:file_prints'))).toBe(true);
    expect(keepsOrderOnCopy(4, holding('queue:create'))).toBe(false);
  });

  it('a closed order is never inherited', () => {
    expect(keepsOrderOnCopy(4, holding('orders:update'), false)).toBe(false);
  });
});
