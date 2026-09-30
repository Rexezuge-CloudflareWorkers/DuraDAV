import { describe, expect, it } from 'vitest';
import { clampPage, clampPageSize, hasNextPage, pageCountFor } from '../apps/web/src/lib/davPage';
import { clampPageNumber, clampPageSize as clampServerPageSize, clampPageToCollection, offsetForPage, pageCountFor as serverPageCountFor } from '../packages/dav-store/src/listing';

/**
 * `?page=` and `?limit=` are user-supplied, so the clamps are the security
 * boundary, not defensive decoration: `?limit=100000` reaching the DO
 * un-clamped would reproduce the full unpaged listing and then serialise it.
 * These assert the clamps hold for the shapes a hand-edited URL can produce.
 */
describe('page size clamping', () => {
  it('accepts the offered sizes unchanged', () => {
    for (const size of [50, 100, 250]) {
      expect(clampPageSize(size)).toBe(size);
    }
  });

  it('caps a size above the ceiling', () => {
    expect(clampPageSize(100_000)).toBe(250);
    expect(clampPageSize(Number.MAX_SAFE_INTEGER)).toBe(250);
  });

  it('accepts a small size unchanged, since a small page is a real request', () => {
    // A script walking 5 entries at a time is legitimate. Rounding *up* to a
    // UI-shaped default would answer a different question than the one asked.
    expect(clampPageSize(1)).toBe(1);
    expect(clampPageSize(5)).toBe(5);
  });

  it('falls back to the default for a non-positive size', () => {
    expect(clampPageSize(0)).toBe(100);
    expect(clampPageSize(-50)).toBe(100);
  });

  it('falls back to the default for non-numeric input', () => {
    for (const value of [NaN, Infinity, -Infinity, null, undefined, {}, []]) {
      expect(clampPageSize(value)).toBe(100);
    }
  });

  it('truncates a fraction so a float cannot reach the SQL LIMIT binding', () => {
    expect(clampPageSize(10.9)).toBe(10);
    expect(clampPageSize(100.9)).toBe(100);
  });

  it('parses a numeric string, as a header or query value arrives', () => {
    expect(clampPageSize('100')).toBe(100);
    expect(clampPageSize('250')).toBe(250);
    expect(clampPageSize('abc')).toBe(100);
  });

  it('clamps identically on the server, which is the enforcement point', () => {
    expect(clampServerPageSize(100_000)).toBe(250);
    expect(clampServerPageSize(10.9)).toBe(10);
    expect(clampServerPageSize(5)).toBe(5);
    expect(clampServerPageSize(100)).toBe(100);
  });
});

describe('page number clamping', () => {
  it('reads a valid page', () => {
    expect(clampPage('3')).toBe(3);
  });

  it('treats a missing or blank page as page 1', () => {
    // `?page=` with an empty value is a real case: these URLs are built by code
    // that omits empty params, and a strict parse would render an empty page 1.
    expect(clampPage(null)).toBe(1);
    expect(clampPage('')).toBe(1);
    expect(clampPage(' '.repeat(3))).toBe(1);
  });

  it('floors zero and negatives to page 1', () => {
    expect(clampPage('0')).toBe(1);
    expect(clampPage('-4')).toBe(1);
  });

  it('falls back to page 1 for non-numeric input', () => {
    expect(clampPage('abc')).toBe(1);
    expect(clampPage('NaN')).toBe(1);
  });

  it('truncates a fraction', () => {
    expect(clampPage('3.9')).toBe(3);
  });

  it('matches the server clamp for the same inputs', () => {
    expect(clampPageNumber('3')).toBe(3);
    expect(clampPageNumber('0')).toBe(1);
    expect(clampPageNumber('-4')).toBe(1);
    expect(clampPageNumber('abc')).toBe(1);
  });
});

describe('page count and offsets', () => {
  it('counts pages with a ceiling division', () => {
    expect(pageCountFor(100, 100)).toBe(1);
    expect(pageCountFor(101, 100)).toBe(2);
    expect(pageCountFor(250, 100)).toBe(3);
    expect(pageCountFor(0, 100)).toBe(1);
  });

  it('agrees between client and server', () => {
    for (const [total, size] of [
      [0, 100],
      [1, 100],
      [100, 100],
      [101, 50],
      [12_431, 250],
    ] as const) {
      expect(pageCountFor(total, size)).toBe(serverPageCountFor(total, size));
    }
  });

  it('converts a 1-based page to a 0-based offset', () => {
    expect(offsetForPage(1, 100)).toBe(0);
    expect(offsetForPage(2, 100)).toBe(100);
    expect(offsetForPage(3, 250)).toBe(500);
  });

  it('never produces a negative offset', () => {
    expect(offsetForPage(0, 100)).toBe(0);
    expect(offsetForPage(-5, 100)).toBe(0);
  });
});

describe('out-of-range page correction', () => {
  /**
   * A `?page=` past the end must serve the last real page, not an empty list.
   * An empty list is a *wrong* answer here — `VolumeFileList` gates its "folder
   * does not exist" state on `entries.length === 0`, so an empty page reads as
   * "this folder is empty" for a folder with 12 entries in it.
   */
  it('clamps a page past the end to the last real page', () => {
    expect(clampPageToCollection(99, 12, 100)).toBe(1);
    expect(clampPageToCollection(99, 250, 100)).toBe(3);
    expect(clampPageToCollection(2, 250, 100)).toBe(2);
  });

  it('reports page 1 for an empty collection so the case is representable', () => {
    expect(clampPageToCollection(5, 0, 100)).toBe(1);
  });

  it('leaves an in-range page untouched', () => {
    expect(clampPageToCollection(1, 250, 100)).toBe(1);
    expect(clampPageToCollection(3, 250, 100)).toBe(3);
  });
});

describe('next-page availability', () => {
  it('disables Next on the last page', () => {
    expect(hasNextPage(1, 1)).toBe(false);
    expect(hasNextPage(2, 2)).toBe(false);
  });

  it('enables Next when a later page exists', () => {
    expect(hasNextPage(1, 2)).toBe(true);
    expect(hasNextPage(2, 3)).toBe(true);
  });
});
