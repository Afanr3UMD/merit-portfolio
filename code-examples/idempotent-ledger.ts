// Merit — idempotent wallet ledger (excerpt, trimmed for clarity)
//
// CONTEXT
// Every balance change in Merit — deposits, escrow locks, refunds, match
// settlements, withdrawals — flows through this one pair of functions. Nothing
// writes a wallet document directly.
//
// THE PROBLEM IT SOLVES
// Money paths get retried. Stripe redelivers webhooks. Firestore transactions
// retry on contention. A scheduled sweeper and a live client can settle the same
// match within milliseconds of each other. Any of those paying twice is a real
// financial loss.
//
// THE APPROACH
// Each mutation carries a caller-supplied idempotency key that is DETERMINISTIC
// for the event it represents:
//
//     match-settlement:{matchId}:{uid}
//     entry-refund:{holdId}
//     deposit_{stripeIntentId}
//
// The key is hashed to produce the ledger document ID. The ledger doc's existence
// IS the idempotency record — if it exists, this mutation already happened. Two
// racing callers therefore converge on the same document, and the second is a
// no-op rather than a second payout.
//
// THE PREPARE/WRITE SPLIT
// Firestore transactions require all reads before any write. Settling a match
// touches BOTH players' wallets, so a single apply-in-place helper cannot work:
// writing player A would happen before reading player B. The split lets a caller
// prepare every mutation (reads), then write them all (writes) in one transaction.

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";

function ledgerIdFor(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

/** READ PHASE — resolves the mutation against current state. Writes nothing. */
export async function prepareWalletLedgerMutation(
  db: Db,
  tx: Tx,
  mutation: WalletLedgerMutation,
): Promise<PreparedWalletLedgerMutation> {
  validateMutation(mutation);

  const ledgerId = ledgerIdFor(mutation.idempotencyKey);
  const ledgerRef = db
    .collection("walletLedgers").doc(mutation.uid)
    .collection("entries").doc(ledgerId);

  const existingLedger = await tx.get(ledgerRef);
  const currentWallet = await readWalletInTransaction(db, tx, mutation.uid);

  // Already applied — return a no-op that the write phase will skip.
  if (existingLedger.exists) {
    return { mutation, wallet: currentWallet, walletBefore: currentWallet, ledgerId, applied: false };
  }

  const nextWallet = applyDelta(currentWallet, mutation.delta);

  // Invariant enforcement: no balance may go negative, and lifetime counters
  // are monotonic. An insufficient-funds escrow lock throws HERE — inside the
  // transaction, before anything is written, so nothing partially applies.
  assertSafeWallet(nextWallet);

  return { mutation, wallet: nextWallet, walletBefore: currentWallet, ledgerId, applied: true };
}

/** WRITE PHASE — pure writes, no awaits. Safe to call for both players. */
export function writePreparedWalletLedgerMutation(
  db: Db,
  tx: Tx,
  prepared: PreparedWalletLedgerMutation,
): void {
  if (!prepared.applied) return; // idempotent no-op

  const { mutation, ledgerId } = prepared;

  // 1. The wallet summary (the fast-read document the client listens to).
  tx.set(walletRef(db, mutation.uid), walletSummaryForWrite(prepared.wallet), { merge: true });

  // 2. The append-only ledger entry — the audit record. Carries balanceBefore
  //    AND balanceAfter so the full history is reconstructible and auditable
  //    without replaying every prior entry.
  tx.set(
    db.collection("walletLedgers").doc(mutation.uid).collection("entries").doc(ledgerId),
    {
      uid: mutation.uid,
      kind: mutation.kind,              // entry_hold | match_settlement | deposit | ...
      amountCents: mutation.amountCents,
      direction: ledgerDirection(mutation.delta),
      delta: normalizeDelta(mutation.delta),
      balanceBefore: snapshotBalances(prepared.walletBefore),
      balanceAfter: snapshotBalances(prepared.wallet),
      source: mutation.source,          // { type: "stripe" | "match" | ..., id }
      idempotencyKey: mutation.idempotencyKey,
      metadata: mutation.metadata ?? {},
      createdAt: FieldValue.serverTimestamp(),
    },
  );

  // 3. A SANITIZED user-visible activity row, derived from the ledger entry.
  //    The raw ledger is server-only (Firestore rules deny client reads) because
  //    it carries processor IDs and internal state. This projection is the only
  //    thing a client ever sees — it is built by an allowlist, never by spreading
  //    metadata, so a new internal field can never accidentally leak.
  const activity = summarizeWalletActivity(mutation, ledgerId);
  if (activity) {
    tx.set(
      db.collection("walletActivities").doc(mutation.uid).collection("items").doc(activity.activityId),
      { ...activity, userId: mutation.uid, ledgerId, createdAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
}

// ---------------------------------------------------------------------------
// RESULT
// Because settlement keys are deterministic, a duplicate settle, a redelivered
// webhook, a retried transaction, and a sweeper firing after a client already
// settled all collapse onto the same ledger document. Unit tests assert this
// directly: applying the same settlement twice leaves wallets byte-identical to
// applying it once, and total value across both players is conserved — the pool
// out never exceeds the pool in, so no code path can mint money.
// ---------------------------------------------------------------------------
