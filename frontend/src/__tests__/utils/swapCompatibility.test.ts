/**
 * The one reading of a source's swap declaration on the wire (swap-source-lifecycle spec r4 §9).
 *
 * The server answers `swap_compatible` with a required `swap_compatibility_known`. A server from
 * before that field answered the bool alone, and only a strict bool is read then. Everything else —
 * no source yet, a failed read, a known flag that is not a bool, a "known" that is not known — is
 * unknown, never False: a False the dialog guessed would run our swap macros over a file that may
 * carry its own.
 */

import { describe, it, expect } from 'vitest';
import { decodeSourceSwapFact, decodeSwapFact, newOperationId } from '../../utils/swapCompatibility';

describe('decodeSwapFact', () => {
  it('reads a known declaration', () => {
    expect(decodeSwapFact({ swap_compatible: true, swap_compatibility_known: true })).toBe(true);
    expect(decodeSwapFact({ swap_compatible: false, swap_compatibility_known: true })).toBe(false);
  });

  it('treats an unknown declaration as unknown, not False', () => {
    expect(decodeSwapFact({ swap_compatible: false, swap_compatibility_known: false })).toBe('unknown');
    // Contradictory: the server never sends it, and it is no permission either way.
    expect(decodeSwapFact({ swap_compatible: true, swap_compatibility_known: false })).toBe('unknown');
  });

  it('reads a legacy answer without the known flag only from a strict bool', () => {
    expect(decodeSwapFact({ swap_compatible: true })).toBe(true);
    expect(decodeSwapFact({ swap_compatible: false })).toBe(false);
    expect(decodeSwapFact({ swap_compatible: 'true' })).toBe('unknown');
    expect(decodeSwapFact({ swap_compatible: 1 })).toBe('unknown');
    expect(decodeSwapFact({})).toBe('unknown');
  });

  it('is unknown for a malformed known flag', () => {
    expect(decodeSwapFact({ swap_compatible: false, swap_compatibility_known: 'yes' })).toBe('unknown');
    expect(decodeSwapFact({ swap_compatible: true, swap_compatibility_known: null })).toBe('unknown');
  });

  it('is unknown while there is no source answer', () => {
    expect(decodeSwapFact(undefined)).toBe('unknown');
    expect(decodeSwapFact(null)).toBe('unknown');
  });
});

describe('decodeSourceSwapFact', () => {
  it("reads the archive's SOURCE pair, never the run's", () => {
    const archive = {
      swap_compatible: true,
      swap_compatibility_known: true,
      source_swap_compatible: false,
      source_swap_compatibility_known: true,
    };
    expect(decodeSourceSwapFact(archive)).toBe(false);
  });

  it('a missing or malformed source pair is unknown -- no legacy reading, no fallback to the run', () => {
    expect(decodeSourceSwapFact({ swap_compatible: true, swap_compatibility_known: true })).toBe('unknown');
    expect(decodeSourceSwapFact({ source_swap_compatible: true })).toBe('unknown');
    expect(decodeSourceSwapFact({ source_swap_compatible: true, source_swap_compatibility_known: 'yes' })).toBe('unknown');
    expect(decodeSourceSwapFact({ source_swap_compatible: true, source_swap_compatibility_known: false })).toBe('unknown');
    expect(decodeSourceSwapFact(undefined)).toBe('unknown');
  });
});

describe('newOperationId', () => {
  it('is a version 4 UUID, fresh every time, even where crypto.randomUUID is missing', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const saved = crypto.randomUUID;
    try {
      // A page served over plain HTTP on the LAN is no secure context: there is no randomUUID there.
      Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
      const first = newOperationId();
      const second = newOperationId();
      expect(first).toMatch(uuid);
      expect(second).toMatch(uuid);
      expect(first).not.toBe(second);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: saved, configurable: true });
    }
  });
});
