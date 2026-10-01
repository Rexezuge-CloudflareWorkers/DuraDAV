export interface CurrentUser {
  email: string;
  username?: string | null;
  /**
   * Preferred UI language (BCP 47 tag). Optional: persisted locally only
   * (`localStorage > navigator > en`).
   */
  preferredLanguage?: string | null;
}

export interface Volume {
  owner: string;
  name: string;
  fullName: string;
  description?: string | null;
  isPrivate: boolean;
  /**
   * How this bucket's `DAV:href` values are anchored.
   *
   * `base` is the RFC 4918 §8.3 form (hrefs carry `/owner/volume`) and what
   * every bucket gets unless its owner asks otherwise. `root` anchors them at
   * `/` for clients that expect the volume root to be the server root. The
   * bucket browser works with either — `davXml.parseMultistatus` tolerates a
   * missing prefix and builds its own request URLs — so this only changes what
   * third-party clients see.
   */
  hrefPrefixMode: DavHrefPrefixMode;
  /**
   * The server's own `href` for this bucket. Carried from the API response and
   * never read by the browser — bucket URLs are built from `owner`/`name`, which
   * are the two fields the browser can trust regardless of the bucket's href
   * prefix mode.
   */
  href: string;
}

export type DavHrefPrefixMode = 'base' | 'root';

export interface VolumeDetail extends Volume {
  description: string | null;
}

export interface BucketCredential {
  credentialId: string;
  name: string;
  username: string;
  passwordPrefix: string;
  passwordLastFour: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  readOnly: boolean;
}

export interface CreatedBucketCredential {
  credentialId: string;
  username: string;
  password: string;
  name: string;
  expiresAt: number;
  passwordPrefix: string;
  passwordLastFour: string;
  readOnly: boolean;
}

export interface UserProfile {
  username: string;
}

/**
 * One row of a bucket listing.
 *
 * `href`, `contentType`, and `etag` are parsed but not read by the browser: the
 * request URL is rebuilt from `path` (which is `href` with the volume prefix
 * removed), so the raw href is never needed again. They are kept because the
 * multistatus parser is the one place the server's `DAV:href` is interpreted at
 * all, and dropping the fields would make the §8.3 prefix-stripping untestable
 * against a real body.
 */
export interface DavEntry {
  href: string;
  name: string;
  path: string;
  isCollection: boolean;
  size: number | null;
  contentType: string | null;
  lastModified: string | null;
  etag: string | null;
}
