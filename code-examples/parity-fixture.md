# Proving cross-language determinism

Server-side replay verification only works if the game engine on the device and the game engine on
the server produce **bit-identical** output. Not "close enough" — identical. If they drift by one
floating-point ULP over a five-minute run, honest players start getting their runs rejected and the
whole trust model inverts into a bug report queue.

Merit's engines exist in up to three languages:

| Engine | Swift (device) | TypeScript (server) | C# (Unity) |
|---|:---:|:---:|:---:|
| Stack | ✅ | ✅ | — |
| Strike | ✅ | ✅ | ✅ |
| Pocket | ✅ (free play only) | ✅ (canonical) | — |
| Outfox | ✅ | — | ✅ |

## The contract

Parity is enforced by golden fixtures, not by convention:

1. **Fixtures are generated from the real Swift engine** — not hand-authored, not derived from a
   spec. A generator drives the actual shipping engine through scripted scenarios.

2. **Float state is stored as raw bit patterns**, in hex — never as rounded decimals. A fixture that
   records `3.14159` proves nothing; a fixture that records `0x400921FB54442D18` proves everything.

   ```json
   {
     "tick": 1200,
     "puckX": "0x4059000000000000",
     "puckY": "0xC02E000000000000",
     "puckVX": "0x40518F5C28F5C28F"
   }
   ```

3. **The other implementations replay the fixtures and assert byte equality** at every checkpoint —
   zero tolerance, no epsilon comparison. The Strike parity suite compares 267 checkpoints across
   5 full-match scenarios and passed on the first run, which also empirically proved the Swift
   compiler emits no FMA contraction in that code.

4. **Any gameplay change must move everything together.** A standing rule: if you touch a mechanic,
   you touch the Swift engine, the server engine, *and* regenerate the fixtures — or the parity suite
   fails and legitimate runs start getting rejected in production. This is written into the project
   memory file so it survives across sessions.

## What actually broke determinism

Real drift sources found and fixed, each of which would have silently rejected honest players:

**`libm` trigonometry.** The only non-portable operations in Strike's entire simulation were three
trig calls. `libm` is not correctly-rounded and differs between Apple's implementation and V8's. They
were replaced with a range-reduced Taylor polynomial (sin error ~2e-11), written **one operation per
statement** so no compiler could contract floating-point differently across targets. The serve angle
was reformulated using the identity `cos(±π/2 + j) = ∓sin j` to eliminate `atan2` entirely.

**Banker's rounding.** C#'s `Math.Round` defaults to round-half-to-even; Swift's `rounded()` does not.
Lane rounding in the runner needed an explicit `MidpointRounding.AwayFromZero` to match.

**Reference vs. value semantics in the port.** The TypeScript port of Strike's physics stores vectors
in objects. Swift's structs copy on assignment; JavaScript objects alias. Every stored-vector
assignment needed an explicit `.copy()` — the single most dangerous class of bug when porting Swift
value types to a reference-type language, and one the type checker cannot catch.

**Integer overflow semantics.** The seeded RNG uses 64-bit multiply-wrap. Swift's `&*` maps to C#
`unchecked` arithmetic and to JavaScript `BigInt` masked to 64 bits — three different spellings of
the same operation, each verified against the same golden sequence.

**Discrete vs. continuous collision math.** Pocket's aim guide used a continuous swept-circle test
while the simulation micro-steps discretely. A graze whose closest approach is a hair under contact
distance is inside range along a chord too short to guarantee a sample lands in it — so the guide
promised hits the simulation sailed past. Fixed with a conservative contact skin, plus a test that
pins the sampling guarantee the skin depends on.

## Regenerating fixtures

Non-obvious enough to be worth documenting in-repo, because it cost a session to work out:

- `swift file1.swift file2.swift` does **not** bring the extra files into module scope.
- `swiftc` only permits top-level expressions in a file literally named `main.swift`.

The working recipe is to copy the generator to `main.swift`, compile it alongside the engine sources,
and run it:

```bash
cp gen_golden.swift /tmp/build/main.swift
cp Engine.swift Board.swift Types.swift /tmp/build/
swiftc -O -o gen main.swift Engine.swift Board.swift Types.swift
./gen > fixtures/engineGolden.json
```

## The payoff

When the Tetris Super Rotation System was fixed (S/Z pieces had only 2 distinct rotation states
instead of 4; J/L/T's "R" state sat one column off the canonical bounding box, which mis-calibrated
the wall-kick tables), the change had to land in Swift *and* TypeScript *and* the regenerated
fixtures simultaneously.

The parity suite then replayed the recorded action logs through the server engine with the new shapes
and matched the new Swift goldens byte-for-byte — proving the client and server stayed in lockstep
through a change that measurably altered gameplay outcomes (one test run went from 17 to 71 lines
cleared, exactly as expected from different rotation shapes producing different placements).

Without the fixtures, that fix would have shipped as a silent wave of rejected honest runs.
