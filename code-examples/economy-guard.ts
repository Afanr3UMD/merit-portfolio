// Merit — economy separation guard (excerpt, unmodified logic)
//
// CONTEXT
// Merit runs two parallel economies that must never mix: real-money "cash"
// (Stripe-backed, escrowed, KYC-gated) and virtual "coins" (no cash value,
// StoreKit-purchased). They live in different Firestore collections, different
// queue buckets, and behind different callables.
//
// Structural separation is the primary defense. This guard is defense-in-depth:
// it is the FIRST line of every economy-scoped callable, before any wallet read
// or escrow lock, so a stale or malicious client cannot smuggle one economy's
// intent into the other's settlement path.
//
// Both functions are pure and side-effect free, which is what makes them
// cheaply unit-testable and safe to call before authentication side effects.

import { HttpsError } from "firebase-functions/v2/https";

/**
 * Rejects any payload carrying coin-economy fields.
 * Called first in every CASH endpoint (arena create/accept, live queue join).
 */
export function assertCashEconomyPayload(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  const economy = typeof d.economy === "string" ? d.economy.toLowerCase() : null;
  const currency = typeof d.currency === "string" ? d.currency.toLowerCase() : null;

  if (
    economy === "coins" ||
    currency === "coins" ||
    d.stakeCoins != null ||
    d.amountCoins != null ||
    d.coinStake != null
  ) {
    throw new HttpsError(
      "failed-precondition",
      "coin_payload_rejected: this endpoint only accepts cash matches.",
    );
  }
}

/**
 * The mirror guard. Rejects any payload carrying cash-economy fields.
 * Called first in every COIN endpoint.
 *
 * Note this is not symmetric decoration — it closes a real direction of attack.
 * Coin endpoints have deliberately weaker entry gates (no KYC, no geographic
 * restriction, since coins have no cash value). Without this guard, a cash-shaped
 * payload reaching a coin endpoint would be a way to route real value through
 * the permissive path.
 */
export function assertCoinEconomyPayload(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  const economy = typeof d.economy === "string" ? d.economy.toLowerCase() : null;
  const currency = typeof d.currency === "string" ? d.currency.toLowerCase() : null;

  if (
    economy === "cash" ||
    currency === "cash" ||
    currency === "usd" ||
    d.stake != null ||
    d.stakeCents != null ||
    d.amountCents != null
  ) {
    throw new HttpsError(
      "failed-precondition",
      "cash_payload_rejected: this endpoint only accepts coin matches.",
    );
  }
}

// ---------------------------------------------------------------------------
// A companion static test asserts that EVERY `onCall` definition in the
// codebase declares `enforceAppCheck: true`, and that every cash-entry callable
// actually calls the location/eligibility gates. Wiring regressions are the
// failure mode a unit test on the guard alone would never catch — so the test
// suite scans the source tree and fails if a new endpoint is added without them.
// ---------------------------------------------------------------------------
