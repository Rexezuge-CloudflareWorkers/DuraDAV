/**
 * Unix timestamps, in seconds.
 *
 * Seconds is the unit throughout, because it is what every `dav_*` table stores
 * (`created_at`, `expires_at`, `last_run_at`) and mixing units in a comparison is
 * the kind of bug that only shows up across a boundary. Where a millisecond
 * precision is genuinely wanted — ordering within a single pass, `Date.now()`
 * arithmetic that is never persisted — call `Date.now()` directly rather than
 * adding a method here, so the unit is visible at the call site.
 */
class TimestampUtility {
  /**
   * Now, in whole seconds.
   *
   * The clock is read through this one function so a test can reason about a
   * single seam, and so a caller cannot accidentally store milliseconds in a
   * column compared against seconds.
   */
  public static getCurrentUnixTimestampInSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Shift a seconds timestamp by whole days.
   *
   * Pure calendar arithmetic on the unit, not `Date` arithmetic: expiry is stored
   * as an absolute second count and compared with `>`, so it must not pick up a
   * timezone or a DST transition on the way.
   */
  public static addDays(timestamp: number, days: number): number {
    return timestamp + days * 60 * 60 * 24;
  }
}

export { TimestampUtility as TimestampUtil };
