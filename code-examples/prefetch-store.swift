// Merit — stale-while-revalidate @Observable store (excerpt, unmodified)
//
// THE BUG
// Users reported a ~6 second blank screen the first time they opened the
// Profile or Friends tab after launch — and only the first time.
//
// ROOT CAUSE
// The first Cloud Functions callable of a session serializes three slow steps
// before any data comes back:
//
//     Firebase ID token  →  App Check attestation  →  cold function container
//
// App Attest/DeviceCheck attestation is slow on first use per launch, then
// cached process-wide. Each screen fired its own read from its own `.task`, so
// whichever tab the user opened first paid the entire tax with an empty view on
// screen. Warm thereafter — which is exactly why it read as "only on first open."
//
// THE FIX
// Two changes, no backend work:
//   1. Prefetch at launch, overlapping the cost with Home-screen time and
//      warming App Check before the user navigates anywhere.
//   2. Move the data into a shared @Observable store with stale-while-revalidate,
//      so screens render last-known data instantly and never blank on an error.

import Foundation
import Observation

@Observable
final class ProfileStore {

    private(set) var summary: CallableAPI.ProfileSummary?
    private(set) var lastError: String?

    /// In-flight refresh. A second caller JOINS it rather than firing a
    /// duplicate callable, so the launch prefetch and the screen's own `.task`
    /// collapse into a single network round-trip instead of racing.
    @ObservationIgnored private var task: Task<Void, Never>?

    @MainActor
    func refresh() async {
        if let task {
            await task.value          // join, don't duplicate
            return
        }
        let t = Task { @MainActor in
            do {
                let result = try await CallableAPI.getProfileSummary()
                self.summary = result.profile
                self.lastError = nil
            } catch {
                // Keep the stale summary — never blank a loaded screen on a
                // transient failure. This is the whole point: a dropped packet
                // must not cost the user the data they were already looking at.
                self.lastError = error.localizedDescription
            }
        }
        task = t
        await t.value
        task = nil
    }

    @MainActor
    func clear() {                    // sign-out / uid change
        task?.cancel()
        task = nil
        summary = nil
        lastError = nil
    }
}

// ---------------------------------------------------------------------------
// CALL SITES
//
// App launch — fire and forget, overlapping the cold-start cost:
//
//     .task {
//         if let uid = auth.uid {
//             Task { await profileStore.refresh() }
//             Task { try? await friendsStore.refresh() }
//         }
//     }
//
// The screen keeps its own `.task { await store.refresh() }`. It is not
// redundant: if the prefetch already finished, this is a cheap revalidation
// against data that is already on screen; if it is still in flight, this joins
// it. Either way the user never sees an empty state.
//
// ProfileScreen replaced its `@State private var profile` with a computed
// property — every existing `profile?.…` access site compiled unchanged:
//
//     private var profile: CallableAPI.ProfileSummary? { store.summary }
//
// ---------------------------------------------------------------------------
// ONE DETAIL WORTH KEEPING
//
// The rank progress bar animates from 0 to the player's real value, and users
// liked that. Prefetching broke it — the data was already present on first
// frame, so the bar rendered pre-filled with no motion.
//
// Fixed by rendering at 0 for the first frame and flipping a flag in `.onAppear`
// (post-layout), letting the bar's own value-change animation carry it up:
//
//     BarMeter(value: revealRanks ? rankProgress : 0)
//         .onAppear { revealRanks = true }
//
// Worth noting because it is the trap in this kind of optimization: making data
// arrive earlier can silently delete an animation that existed only because the
// data used to arrive late.
// ---------------------------------------------------------------------------
