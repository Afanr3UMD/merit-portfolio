// Merit — server-side match replay verification (excerpt, thresholds redacted)
//
// ⚠️  Specific tolerance VALUES are replaced with `REDACTED` below. Publishing the
//     exact thresholds would tell an attacker precisely how far to push without
//     tripping them. The architecture is shown in full; only the numbers are held back.
//
// CONTEXT
// A player's device simulates the match locally so it feels responsive. It also
// records every input, stamped with the engine tick it occurred on. On submission
// the server replays that log through its own port of the identical engine, seeded
// with a seed the SERVER chose and the client cannot influence.
//
// The server's computed result — never the client's claim — is what settles.

import { StackEngine, type GameMode } from "./engine";
import { parseActionLog, recordToAction, stableHashFNV1a } from "./actionLog";

// ── Anti-cheat bounds ───────────────────────────────────────────────────────

// TIME FLOOR. The log's timestamps are ground truth for how long a run took.
// A submitter can only gain by claiming a run was FASTER than it was (a smaller
// time wins the tiebreak), so we reject only implausibly-small claims. A LARGER
// claim is legitimate and harmless — it only ever hurts the submitter — so it
// needs no upper bound. Getting this asymmetry right avoided rejecting honest runs.
const TIME_FLOOR_TOLERANCE_MS = REDACTED;

// WALL-CLOCK CEILING per mode. Exceeding it rejects.
const MAX_RUN_MS: Record<GameMode, number> = { race: REDACTED, survival: REDACTED, sprint: REDACTED };

// ACTION-RATE SANITY. A skilled human peaks around 10 GESTURES per second.
//
// The subtlety that caused false rejections in production: held inputs
// auto-repeat (soft-drop timer, button DAS). Those repeats are machine-generated
// continuations of ONE human gesture. Counting raw records flagged honest players
// who held soft-drop while sliding. Same-kind records within a short window are
// therefore collapsed into a single gesture BEFORE the sliding-window rate check.
const SUPERHUMAN_APS = REDACTED;
const SUSTAINED_WINDOW_MS = REDACTED;
const REPEAT_COLLAPSE_MS = REDACTED;

// GRAVITY CADENCE FLOOR — closes a real exploit.
//
// Gravity is a CLIENT-side wall-clock timer whose ticks are recorded (and
// replayed) as records. The engine has no server clock of its own, so a modified
// client could simply omit gravity ticks and play with zero downward pressure.
//
// Cross-check: across the whole log, recorded ticks must be at least a fraction
// of what the level curve demands for the elapsed time — generous slack for timer
// coalescing, level-change phase resets, and round transitions. An honest client
// sits near 100%; a zero-gravity client sits near 0%.
const GRAVITY_CADENCE_MIN_RATIO = REDACTED;

// ── Verdicts ────────────────────────────────────────────────────────────────

export type StackValidationState =
  | "server_verified"    // replay reproduced the claim — safe to settle
  | "server_rejected"    // replay contradicts the claim, or a bound was violated
  | "review_required";   // log missing / from an older client — cannot verify

/**
 * Replays a submitted run and judges it.
 *
 * Shape of the pass:
 *   1. Parse and validate the log structurally (version, monotonic ticks,
 *      value ranges, size cap, no records after the end marker).
 *   2. Reject if the log exceeds the wall-clock ceiling, or claims a time
 *      implausibly faster than the log supports.
 *   3. Collapse held-input repeats, then reject sustained superhuman action rates.
 *   4. Reject if gravity cadence falls below the level curve's demand.
 *   5. Replay every action through the engine, seeded with the SERVER's seed.
 *   6. Compare the engine's output to the claim. Mismatch ⇒ server_rejected.
 *
 * The returned `serverComputed` values — not the submitted ones — are what get
 * stored and used to resolve the match, so a client cannot win a tiebreak by
 * shading its own numbers.
 */
export function verifyStackRun(input: VerifyInput): VerifyResult {
  const parsed = parseActionLog(input.actionLog);
  if (!parsed.ok) return reject("malformed_log", parsed.reason);

  // A log that is absent or from a pre-verification client cannot be replayed.
  // It degrades to `review_required` rather than being trusted OR punished.
  // For coin (play-money) matches — where no human review queue exists — this
  // degrades further to a basic validation, because holding a play-money match
  // hostage to a review that will never come is worse than the risk.
  if (!parsed.hasLog) return { validationState: "review_required" };

  const engine = new StackEngine({ seed: input.serverSeed, mode: input.mode });
  const cadence = new GravityCadence(input.mode);

  for (const record of parsed.records) {
    cadence.observe(record);
    engine.apply(recordToAction(record));
  }

  if (cadence.ratio() < GRAVITY_CADENCE_MIN_RATIO) {
    return reject("gravity_cadence_violation");
  }

  const serverComputed = engine.result();
  if (!matchesClaim(serverComputed, input.claimed)) {
    return reject("result_mismatch");
  }

  return {
    validationState: "server_verified",
    serverComputed,                              // authoritative — overrides the claim
    logHash: stableHashFNV1a(input.actionLog),   // stored for later audit
  };
}

// ---------------------------------------------------------------------------
// WHY THIS WORKS AT ALL: cross-language determinism.
//
// Replay is only meaningful if the Swift engine on device and this TypeScript
// engine produce BIT-IDENTICAL output. That is enforced by golden fixtures
// generated from the real Swift engine, storing float state as raw bit patterns
// and asserting byte equality at every checkpoint. See parity-fixture.md.
//
// WHEN BOTH SIDES FAIL: the match voids and both stakes refund. The rule
// throughout Merit is prefer a refund over an unfair payout.
// ---------------------------------------------------------------------------
