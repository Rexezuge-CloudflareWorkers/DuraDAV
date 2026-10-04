import { EnvParser } from '../EnvParser';
import {
  DEFAULT_MAX_REPLICATION_FAILURES,
  DEFAULT_MAX_REPLICATIONS_PER_VOLUME,
  DEFAULT_REPLICATION_ALLOWED_HOSTS,
  DEFAULT_REPLICATION_HASH_ON_AMBIGUOUS,
  DEFAULT_REPLICATION_PASS_MAX_MS,
  DEFAULT_REPLICATION_SLICE_BYTES,
  DEFAULT_REPLICATION_SLICE_MS,
  DEFAULT_REPLICATION_SLICE_PATHS,
  DEFAULT_REPLICATION_SWEEP_LIMIT,
  DEFAULT_REPLICATION_TIMEOUT_MS,
} from '../ConfigurationDefaults';

// Scheduled-replication limits (Strategy: one section per config concern, so
// `AppConfiguration` stays a thin Facade and every knob has one owner).
//
// The slice budgets are the interesting ones. `CronTasksWorker` runs every task
// inside one Durable Object invocation, which is bounded in both CPU and wall
// time, and a two-way sync of a large bucket does not fit in either. So a tick
// does a bounded amount of work, records where it stopped, and the next tick
// continues. Raising `REPLICATION_SLICE_PATHS` without raising the wall-clock
// budget is the change that turns a slow sync into a timed-out one.
class ReplicationConfig {
  constructor(private readonly env: unknown) {}

  /**
  Replications attempted per cron tick, across the whole deployment.
  */
  public getReplicationSweepLimit(): number {
    return EnvParser.positiveInt(this.env, 'REPLICATION_SWEEP_LIMIT', DEFAULT_REPLICATION_SWEEP_LIMIT);
  }

  /**
  Paths visited in one slice before parking the cursor.
  */
  public getReplicationSlicePaths(): number {
    return EnvParser.positiveInt(this.env, 'REPLICATION_SLICE_PATHS', DEFAULT_REPLICATION_SLICE_PATHS);
  }

  /**
  Bytes moved in one slice before parking the cursor.
  */
  public getReplicationSliceBytes(): number {
    return EnvParser.positiveInt(this.env, 'REPLICATION_SLICE_BYTES', DEFAULT_REPLICATION_SLICE_BYTES);
  }

  /**
  Wall-clock budget for one slice.
  */
  public getReplicationSliceMs(): number {
    return EnvParser.positiveInt(this.env, 'REPLICATION_SLICE_MS', DEFAULT_REPLICATION_SLICE_MS);
  }

  /**
   * How long a pass may stay in flight before it is abandoned.
   *
   * Not a performance knob — it is the deletion gate's staleness bound. A pass
   * that errors on one path would otherwise hold "a pass is in flight"
   * indefinitely, and every deletion in the tree would stay deferred forever
   * with nothing to tell the owner why.
   */
  public getReplicationPassMaxMs(): number {
    return EnvParser.positiveInt(this.env, 'REPLICATION_PASS_MAX_MS', DEFAULT_REPLICATION_PASS_MAX_MS);
  }

  /**
  Consecutive failed passes before a replication disables itself.
  */
  public getMaxReplicationFailures(): number {
    return EnvParser.positiveInt(this.env, 'MAX_REPLICATION_FAILURES', DEFAULT_MAX_REPLICATION_FAILURES);
  }

  public getMaxReplicationsPerVolume(): number {
    return EnvParser.positiveInt(this.env, 'MAX_REPLICATIONS_PER_VOLUME', DEFAULT_MAX_REPLICATIONS_PER_VOLUME);
  }

  /**
  Per-request timeout against a remote WebDAV server.
  */
  public getReplicationTimeoutMs(): number {
    return EnvParser.positiveInt(this.env, 'REPLICATION_TIMEOUT_MS', DEFAULT_REPLICATION_TIMEOUT_MS);
  }

  /**
   * Hosts exempt from the egress policy.
   *
   * Empty by default, which refuses loopback, link-local, and RFC 1918 targets.
   * This exists because the most common replication target in practice is a
   * self-hosted server on a private network, and a policy with no way to permit
   * it would make the feature unusable exactly where it is wanted. It is a
   * widening of the SSRF boundary and is reported by `validate()`.
   */
  public getReplicationAllowedHosts(): string {
    return EnvParser.string(this.env, 'REPLICATION_ALLOWED_HOSTS', DEFAULT_REPLICATION_ALLOWED_HOSTS);
  }

  /**
   * Hash both sides when their validators disagree but their sizes match.
   *
   * Off by default: it costs two full reads per ambiguous file on every pass,
   * and the alternative it guards against — assuming equal size means equal
   * content — is exactly the silent data loss this feature must not have.
   */
  public isReplicationHashOnAmbiguous(): boolean {
    return EnvParser.boolean(this.env, 'REPLICATION_HASH_ON_AMBIGUOUS', DEFAULT_REPLICATION_HASH_ON_AMBIGUOUS);
  }
}

export { ReplicationConfig };
