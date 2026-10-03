# Jev Build Sentinel — Demo Video Recording Guide

Target length: **2–3 minutes**. One rule: **only show measured numbers — never invent or round in your favor.**

All timings below were actually measured on 2026-10-02/03 (local machine and GitHub-hosted runners).

## The three proof PRs (all open and green on `Adityakk9031/jev-demo`)

| Beat | PR | Branch | Decision | Evidence | Timing |
|---|---|---|---|---|---|
| Skip | [#1 Docs: README tagline](https://github.com/Adityakk9031/jev-demo/pull/1) | `demo/readme-skip` | SKIP (risk 0, confidence 1.00) | `Decision: SKIP` | workflow **13s** |
| Targeted | [#2 Payments: tighten validation](https://github.com/Adityakk9031/jev-demo/pull/2) | `demo/payment-targeted` | TARGETED (risk 0.765, confidence 0.93) | `▶ Executing TARGETED verification (3 test files): npx vitest run tests/payments/…` → `exit 0 in 0.9s` | job **17s** |
| Full | [#3 DB migration: archive refunds](https://github.com/Adityakk9031/jev-demo/pull/3) | `demo/migration-full` | FULL (risk 0.57, confidence 0.17) — `Safety policy triggers: high-risk change: database migration` | `▶ FULL verification finished: exit 0 in 156.2s` → `Tests 157 passed (157)` | job **2m47s** |

Baselines (measured): full suite **157 tests / 156.2s** on a runner (153s local), unit-only **4s**, targeted 3 files (15 tests) **0.9s**.

## Shot list

### 0:00–0:12 — Cold open: the pain
Start on a terminal running `npx vitest run` in `demo-app/` (or the Demo 3 Actions run).
Let it tick past a minute, then **speed the clip up** (label it "×8") to `Tests 157 passed … 156.2s`.
Voiceover/text: *"Every PR pays 2 minutes 36 seconds — even a typo fix."*

### 0:12–0:25 — The idea (text card only, no talking head)
> Jev Build Sentinel asks TypeSafe's Jev API: *how much CI does this PR actually need?*
> SKIP / TARGETED / FULL — wrapped in a deterministic safety policy.

### 0:25–0:50 — Demo 1: the cheap change → SKIP
1. PR #1 page, 2s on the diff (one README line).
2. Checks → run page → expand the `sentinel` step.
3. Zoom on: `Decision: SKIP (risk 0, confidence 1)`.
4. End on the green ✓ with job time **13s**.

### 0:50–1:25 — Demo 2: payments change → TARGETED
1. PR #2, Files changed — three files under `src/payments/`.
2. Run page → the log lines:
   - `Decision: TARGETED (risk 0.765, confidence 0.93)`
   - `▶ Executing TARGETED verification (3 test files): npx vitest run tests/payments/checkout.test.ts …`
   - `▶ TARGETED verification finished: exit 0 in 0.9s`
3. On-screen stat: **3 test files (15 tests) — 0.9s** vs 157 tests — 2m36s.
4. Optional trust detail: Jev reported regression risk 0.78 — *just under* the 0.8 escalation bar, which is why the safety policy let TARGETED stand.

### 1:25–2:10 — Demo 3: schema migration → FULL (the trust beat)
1. PR #3, Files changed — new `db/migrations/005_archive_refunds.sql`.
2. Run page → the annotations: `Safety policy triggers: high-risk change: database migration`.
3. The log lines: `Decision: FULL` … `▶ Executing FULL verification (all tests): npx vitest run` …
   `▶ FULL verification finished: exit 0 in 156.2s` … `Tests 157 passed (157)`.
4. **Speed up the 156s** segment (label "×8") and land on the green ✓.
   VO: *"When it matters, Sentinel refuses to optimize — and runs everything."*

### 2:10–2:35 — Comparison card (all measured)
```
                  verification chosen   wall time
README typo       SKIP  (0 tests)       13s
payments change   TARGETED (15 tests)   0.9s
schema migration  FULL (157 tests)      2m36s
```
Headline: **157 tests · 2m36s  →  15 tests · 0.9s**

### 2:35–3:00 — End card
- `uses: Adityakk9031/jev-build-sentinel@v1`
- https://github.com/Adityakk9031/jev-build-sentinel
- Works with your existing `JEV_API_KEY` repo secret.

## Recording setup

- **Tool**: OBS Studio (free, 1080p60) for desktop + terminal, or macOS `Cmd+Shift+5` / Windows Game Bar for quick takes.
- **Browser**: GitHub dark theme, zoom to 125–150% (`Cmd/Ctrl` + `+`) so log text is readable, bookmarks bar hidden, other tabs closed.
- **Terminal**: font size ≥ 18px for the cold-open full-suite shot.
- Frame the window only — no desktop icons, no personal tabs.

## Practical tips

- **Don't record waits.** Start the PR, pause the recorder, resume when the run finishes.
- **Re-takes**: `gh run rerun <id> -R Adityakk9031/jev-demo` re-runs a workflow with the same commit (free re-take, same green result). For a pristine PR page, recreate the branch from `main` with a new trivial edit and open a fresh PR.
- **Be honest with edits**: speed up long segments and label them (e.g. "×8"); don't cut in a way that fakes timings.
- The `Node.js 20 deprecated` annotation on runs is cosmetic (the action runs on `node20` via `action.yml`); just don't zoom into it.
- Show the `▶` executor lines — they are the proof that tests actually ran, not just that a decision was printed.
- After filming: merge or close the three demo PRs so the repo page stays clean.
