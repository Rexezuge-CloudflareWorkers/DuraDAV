export interface DavCredentialMetadata {
  credentialId: string;
  volumeId: string;
  name: string;
  username: string;
  passwordPrefix: string;
  passwordLastFour: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  /**
   * Migration 0005. `true` restricts this credential to the read methods
   * (GET/HEAD/OPTIONS/PROPFIND) and refuses every write with 403.
   *
   * A missing column reads as `false`, which is the safe direction: a flag that
   * failed to load degrades to the credential's historical behaviour rather
   * than to a locked-out user.
   */
  readOnly: boolean;
}

export interface DavCredentialInternal {
  credential_id: string;
  volume_id: string;
  username: string;
  password_hash: string;
  name: string;
  password_prefix: string;
  password_last_four: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  read_only: number;
}
