import type { DavEntry } from '../types';

function stripSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

// WebDAV servers may prefix element names (`D:href`, `d:href`, or bare
// `href`). Collapsing prefixes up front keeps the scanners below plain
// substring searches instead of namespace-aware regular expressions.
function stripNamespacePrefixes(xml: string): string {
  return xml.replaceAll(/<(\/?)[a-z][\w.-]*:/gi, '<$1');
}

function stripTags(value: string): string {
  let out = '';
  let inTag = false;
  for (const ch of value) {
    if (ch === '<') {
      inTag = true;
      continue;
    }
    if (ch === '>') {
      inTag = false;
      continue;
    }
    if (!inTag) out += ch;
  }
  return out;
}

function pickTag(block: string, local: string): string | null {
  const exact = `<${local}>`;
  const exactAt = block.indexOf(exact);
  let contentStart: number;
  if (exactAt === -1) {
    // Tolerate attributes on the opening tag (`<href xml:lang="…">`).
    const attrOpen = `<${local} `;
    const attrAt = block.indexOf(attrOpen);
    if (attrAt === -1) return null;
    const gt = block.indexOf('>', attrAt + attrOpen.length);
    if (gt === -1) return null;
    contentStart = gt + 1;
  } else {
    contentStart = exactAt + exact.length;
  }
  const end = block.indexOf(`</${local}>`, contentStart);
  return end === -1 ? null : stripTags(block.slice(contentStart, end)).trim();
}

function splitResponses(xml: string): string[] {
  const out: string[] = [];
  const normalized = stripNamespacePrefixes(xml);
  const chunks = normalized.split('</response>');
  for (const chunk of chunks) {
    const openAt = chunk.indexOf('<response');
    if (openAt === -1) continue;
    const gt = chunk.indexOf('>', openAt);
    if (gt === -1) continue;
    out.push(chunk.slice(gt + 1));
  }
  return out;
}

/**
 * Is this response the collection being listed?
 *
 * A `Depth: 1` PROPFIND returns the collection itself plus its members (§9.1),
 * and the self response is not a member. Compared case-insensitively because
 * the volume-prefix strip above is: the two used different comparisons, so a
 * folder reached with a differently-cased `?path=` failed the exact test and
 * rendered its own self response as a row pointing at itself.
 */
function isSelfResponse(hrefPath: string, normalizedBase: string): boolean {
  return hrefPath.toLowerCase() === normalizedBase.toLowerCase();
}

/**
 * Parses an RFC 4918 `207 multistatus` body into directory entries.
 * Namespace-prefix agnostic (`D:`, `d:`, or none) so it stays robust across
 * server renderers.
 *
 * `volumePrefix` is the volume's public base (`/<owner>/<volume>`). Server hrefs
 * include it, as RFC 4918 §8.3 requires — every `DAV:href` must resolve
 * against the request URL — so it is stripped to recover the volume-relative
 * path the UI works in. The parser still tolerates hrefs *without* the prefix
 * so it keeps working against a non-conforming server.
 *
 * ## Why an unparseable body throws
 *
 * `VolumeFileList` renders `entries.length === 0` as a positive assertion:
 * "Empty Folder. Upload A File Or Create A Subfolder." An empty array is
 * therefore a *claim about the server's contents*, not an absence of
 * information — so answering `[]` to "I could not parse this body" states a
 * falsehood, and the only case where that matters is the one a user hits.
 *
 * The old parser scanned for `<response` and returned `[]` when it found none,
 * never checking that the document was a multistatus at all. That was not
 * hypothetical: a `Depth: 1` PROPFIND on a *file* is perfectly conforming and
 * contains only the self response, which was then skipped — so opening
 * `?path=<a-file>` rendered "Empty Folder" over a file that exists and has
 * content. A share link to a file is not an edge case.
 *
 * So the three outcomes are now distinct: a folder listing drops its self
 * response, a file listing *keeps* it as a single-entry listing (the UI then
 * describes the file, which is true), and a body that is not a multistatus is
 * an error rather than an empty folder.
 */
export function parseMultistatus(xml: string, basePath: string, volumePrefix = ''): DavEntry[] {
  const normalizedBase = stripSlashes(basePath);
  const prefix = stripSlashes(volumePrefix);
  const normalized = stripNamespacePrefixes(xml);
  if (!/<multistatus[\s>]/.test(normalized)) {
    throw new Error('Response was not a DAV multistatus body');
  }
  const blocks = splitResponses(normalized);
  if (blocks.length === 0) {
    throw new Error('DAV multistatus body contained no response elements');
  }
  const entries: DavEntry[] = [];
  let selfEntry: DavEntry | null = null;
  let sawHref = false;
  for (const block of blocks) {
    const rawHref = pickTag(block, 'href');
    if (!rawHref) continue;
    sawHref = true;
    let hrefPath = decodeHref(rawHref);
    const queryAt = hrefPath.indexOf('?');
    if (queryAt !== -1) hrefPath = hrefPath.slice(0, queryAt);
    try {
      // Tolerate absolute URLs too.
      if (hrefPath.startsWith('http://') || hrefPath.startsWith('https://')) {
        hrefPath = new URL(hrefPath).pathname;
      }
    } catch {
      // keep raw
    }
    hrefPath = stripSlashes(hrefPath);
    // Drop the volume prefix so `path` stays volume-relative.
    if (prefix !== '' && hrefPath.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) {
      hrefPath = hrefPath.slice(prefix.length + 1);
    } else if (hrefPath.toLowerCase() === prefix.toLowerCase()) {
      hrefPath = '';
    }

    const isCollection = block.includes('<collection');
    const sizeText = pickTag(block, 'getcontentlength');
    const size = sizeText === null || sizeText === '' ? null : Number(sizeText);
    const slashAt = hrefPath.lastIndexOf('/');
    const name = slashAt === -1 ? hrefPath : hrefPath.slice(slashAt + 1);
    const entry: DavEntry = {
      href: rawHref,
      name,
      path: hrefPath,
      isCollection,
      size: size !== null && Number.isFinite(size) ? size : null,
      contentType: pickTag(block, 'getcontenttype'),
      lastModified: pickTag(block, 'getlastmodified'),
      etag: pickTag(block, 'getetag'),
    };
    if (isSelfResponse(hrefPath, normalizedBase)) {
      // Held back, then re-added below only if it is the *only* response — which
      // is what "this path is a file" looks like from the client's side.
      selfEntry = entry;
      continue;
    }
    entries.push(entry);
  }
  if (!sawHref) {
    throw new Error('DAV multistatus response had no href');
  }
  // A `Depth: 1` PROPFIND on a **file** is conforming (§9.1) and returns exactly
  // one response: the file itself. That is a one-entry listing, and reporting it
  // as `[]` is how the UI came to assert that an existing file was an empty
  // folder. Its `resourcetype` carries no `<collection/>`, which is the only thing
  // that distinguishes it.
  //
  // An **empty collection** also returns exactly one response, and that one *is* a
  // collection — so it stays dropped and the folder correctly reads as empty. The
  // `isCollection` test is load-bearing: without it, every empty folder in the
  // bucket would render a phantom row pointing at itself.
  if (selfEntry !== null && entries.length === 0 && !selfEntry.isCollection) {
    entries.push(selfEntry);
  }
  // Deterministic order: collections first, then case-insensitive name.
  entries.sort((a, b) => {
    if (a.isCollection !== b.isCollection) return a.isCollection ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return entries;
}

/**
 * Join a folder path and a child name.
 *
 * Exported for the unit tests only — nothing in `src` calls it, since every
 * path the browser requests is reconstructed from `DavEntry.path` (already
 * volume-relative) or from a breadcrumb segment. It is retained as the
 * documented counterpart to `parentDavPath` so the two directions of the same
 * transformation are tested against each other.
 */
export function joinDavPath(base: string, name: string): string {
  const clean = stripSlashes(base);
  const leaf = stripSlashes(name);
  return clean === '' ? leaf : `${clean}/${leaf}`;
}

export function parentDavPath(path: string): string | null {
  const clean = stripSlashes(path);
  if (clean === '') return null;
  const index = clean.lastIndexOf('/');
  return index === -1 ? '' : clean.slice(0, index);
}

export { stripSlashes };