import { describe, expect, it } from 'vitest';
import { generatePropfindResponse } from '@durable-dav/webdav';
import type { DavNodeInfo } from '@durable-dav/webdav';
import { parseMultistatus, joinDavPath, parentDavPath } from '../apps/web/src/lib/davXml';

function node(key: string, isCollection: boolean, size = 0): DavNodeInfo {
  return {
    key,
    isCollection,
    size,
    etag: isCollection ? undefined : `"${size.toString(16)}-abc"`,
    mtime: new Date('2026-01-02T03:04:05Z'),
    crtime: new Date('2026-01-01T00:00:00Z'),
    contentType: isCollection ? undefined : 'text/plain',
    displayname: key === '' ? undefined : (key.split('/').pop() ?? undefined),
    locks: [],
    deadProperties: [],
  };
}

function multistatus(nodes: DavNodeInfo[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">${nodes.map((n) => generatePropfindResponse(n, 'allprop', [])).join('')}\n</multistatus>\n`;
}

describe('web PROPFIND parser (browser/server round-trip)', () => {
  it('parses Depth:1 listing and drops the self response', () => {
    const xml = multistatus([node('', true), node('photos', true), node('notes.txt', false, 42)]);
    const entries = parseMultistatus(xml, '');
    expect(entries.map((e) => e.name)).toEqual(['photos', 'notes.txt']);
    expect(entries[0]?.isCollection).toBe(true);
    expect(entries[1]?.isCollection).toBe(false);
    expect(entries[1]?.size).toBe(42);
    expect(entries[1]?.contentType).toBe('text/plain');
    expect(entries[1]?.path).toBe('notes.txt');
  });

  it('parses subdirectory listings with nested paths', () => {
    const xml = multistatus([node('photos', true), node('photos/a.jpg', false, 7), node('photos/raw', true)]);
    const entries = parseMultistatus(xml, 'photos');
    expect(entries.map((e) => e.path)).toEqual(['photos/raw', 'photos/a.jpg']);
    expect(entries.map((e) => e.name)).toEqual(['raw', 'a.jpg']);
  });

  it('is namespace-prefix agnostic', () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/f.txt</d:href><d:propstat><d:prop><d:getcontentlength>3</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const entries = parseMultistatus(xml, '');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'f.txt', path: 'f.txt', isCollection: false, size: 3 });
  });

  it('detects collections via resourcetype', () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>/d/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const entries = parseMultistatus(xml, '');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.isCollection).toBe(true);
  });
});

describe('web dav path helpers', () => {
  it('joins and walks parents', () => {
    expect(joinDavPath('', 'a')).toBe('a');
    expect(joinDavPath('a/b', 'c')).toBe('a/b/c');
    expect(parentDavPath('a/b/c')).toBe('a/b');
    expect(parentDavPath('a')).toBe('');
    expect(parentDavPath('')).toBeNull();
  });
});
