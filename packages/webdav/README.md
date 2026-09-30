# `@durable-dav/webdav` — Pure RFC 4918 Helpers

Zero-runtime-dependency WebDAV core (except `@xmldom/xmldom` for XML parsing). No `dofs`, no D1, no DO — unit-testable in Node.

Ported from `../r2-webdav/src/index.ts` (R2 reference, Class 1+2). Storage replaced by callers (`DavVolumeWorker` uses `dofs` + SQLite; R2 `customMetadata` has no `dofs` equivalent).

- `path.ts` — `escapeXml`, `getResourceHref`, `decodeResourcePath`, `getParentPath`, `parseDestinationPath` (same-origin), `isSameOrDescendantPath`, `normalizeVolumeKey` (lowercase `owner/volume` DO key), `splitVolumePath` (`/owner/volume/inner`).
- `xml.ts` — `DOMParser` wrapper (`parseXmlDocument` fail-null), `parsePropfindRequest` (`allprop/propname/prop`, empty body → `allprop`), `parseProppatchRequest` (`set/remove`), renderers (`renderDavProperty`, `renderPropertyElement`, `renderPropstat`), `extractLockOwner`.
- `props.ts` — live props (`creationdate/displayname/getcontentlength/type/language/etag/lastmodified/resourcetype/supportedlock/lockdiscovery`), dead-prop keys (`dead_property:<ns>:<name>`), `isProtectedProperty` (locks + `resourcetype`), `generatePropfindResponse` (200/404 propstats).
- `locks.ts` — `LockDetails`, `parseTimeout` (`Second-N`/`Infinite`, clamped), `normalizeLockToken` (`<urn:uuid:>/<opaquelocktoken:>` stripped), `getRequestLockTokens` (`Lock-Token` + `If`), `hasAlwaysFalseIfCondition` (`<DAV:no-lock>`), `determineLockDepth` (collections default `infinity`), `getLockDiscovery`, `timingSafeEqual`.
- `constants.ts` — `DAV_CLASS = '1, 2'`, `SUPPORT_METHODS` (12 methods), CORS header sets, `createdResponse` (201 + `Location`), `applyCors`, `davErrorResponse(status, condition?)` (RFC 4918 §16 `DAV:error` body). `condition` is a local name in the `DAV:` namespace and is omitted when absent; the sibling `responsedescription` RFC 4918 also asks for is deliberately not emitted, since inventing a human-readable string on the wire would mean a second set of translated messages on a path that has none.

Status-code parity with reference: `207` PROPFIND/PROPPATCH, `201/204` PUT/COPY/MOVE, `400` bad XML/Destination, `403` protected props/root delete, `404` missing, `405` wrong method, `409` missing parent, `412` `Overwrite: F`/no-lock, `413` oversize, `423` locked, `507` storage.
