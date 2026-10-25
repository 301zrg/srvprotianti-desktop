# Desktop update manifest implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Initial local-only work is complete; the user subsequently authorized source publication, release/queuing, and restarting the original cmd after verified recovery.

**Goal:** Check assistant versions without unauthenticated GitHub REST requests; retain manual browser download and useful offline behavior.

**Architecture:** Each application Release carries `desktop-update.json` beside its ZIP. The native updater fetches the latest JSON over restricted HTTPS redirects, validates metadata, caches successes for 600 seconds, and retains explicitly stale results after failures. Release publication uploads and verifies both assets in a draft before making it public/latest.

**Tech Stack:** Existing Rust/reqwest/semver, Tauri bridge, plain JavaScript, Node test runner, GitHub Actions/gh. No new dependencies.

**Spec:** User-approved recommendation in this conversation; permanent contract belongs in DESIGN.md section 12.1 and docs/ARCHITECTURE.md.

## Global constraints

- Initial local-only boundary has been lifted by the user on 2026-10-26. Use the existing release workflow and append a new immutable batch after the already armed batch. Do not replay old or uncertain launches.
- Base: `87933444bbeacbc7b203ac6a0a81070f863ec345`, including the pending page changes. Worktree/branch: `.audit-tmp/desktop-update-manifest-20261026`, `feat/desktop-update-manifest-20261026`.
- Candidate version is 0.2.1, confirmed unused on GitHub before publication; all package/Cargo/Tauri version files must match. Do not reuse v0.2.0.
- No automatic executable installation, GitHub tokens in clients, HTTP update fallback, or changes to business API redirect permissions.
- Application metadata and signed page metadata remain independent; page Releases keep `make_latest=false`.
- Manifest schema 1: `version`, `tag`, `sourceCommit`, and `asset: {name,size,sha256}`. Exact application ZIP name; stable canonical semver/tag; lowercase 40/64 hex commit/hash; positive safe-integer size.
- Construct download URLs locally from validated tags, never accept arbitrary download URLs from metadata. SHA-256 is descriptive while browser/manual installation remains in use; this is not executable signature validation.
- Success TTL 600 seconds, failure cooldown at least 30 seconds; respect bounded Retry-After/reset headers. In-memory cache is shared across page visits for one application process, not persisted across restarts.

## Review focus

- An unavailable/invalid manifest must never produce a fresh “already latest” result.
- Stale or older cached results are labeled with their original check time.
- Concurrent checks and repeated failures do not multiply requests; URLs/redirects cannot switch to untrusted hosts or HTTP.
- Draft uploads, digest mismatches, conflicting tags, and unknown publication outcomes must never be reported as successful publication.
- A page package targeting older EXEs must not lose the permanent manual-download escape hatch or invoke a new native command unconditionally.

### Task 1: Native metadata and cache

**Files:** src-tauri/src/updater.rs, src-tauri/src/lib.rs.

**Interfaces:** `check_desktop_update` keeps its command name; adds optional `status`, `checkedAt`, `retryAt`, `error` fields to the existing result. `downloadUrl` pins the checked tag. Native state owns cache/mutex. Errors contain stable codes, not raw network exception text.

- [x] Write and run a failing valid-manifest test against the old Release JSON parser.
- [x] Implement strict parsing, dedicated redirect-restricted client, bounded body/timeouts, cache and failure cooldown.
- [x] Test success, invalid metadata, HTTP failures, cache boundaries, stale retention, recovery and redirects using local fixtures.

### Task 2: Release assets and settings

**Files:** scripts/desktop-release.mjs, scripts/desktop-release.test.mjs, .github/workflows/windows-desktop.yml, settings.html, src/desktop-bridge.ts, scripts/desktop-updates-ui.test.mjs, package.json.

**Interfaces:** Generator/validator use the schema in Global constraints. Native `openUpdateDownload(url?)` accepts a checked tag URL or the existing latest URL when omitted. Settings always expose the official Release page and localize failure classes in zh/ja/en/ko.

- [x] Write failing generation/publication/UI behavior tests.
- [x] Generate and independently verify ZIP metadata; draft upload/read-back digest verification before publication. Existing/uncertain Releases require review instead of overwrite.
- [x] Keep cached/stale results and timestamps visible; do not display unknown state as latest; test old bridge compatibility and single in-flight check.
- [x] Wire all new tests into npm run check and run the full frontend suite and scoped native tests. Full application native testing remains gated by the local toolchain limitation below.

### Task 3: Documentation, review, local handoff

**Files:** README.md, DESIGN.md, docs/ARCHITECTURE.md, this plan.

- [x] Update existing contracts, architecture diagram and release flow; record local verification and deferred release conditions here.
- [x] Run formatting, frontend checks and a focused browser smoke; review the complete diff and address material findings. Full Windows application validation remains a release gate.
- [x] Preserve a local commit and record it here/with handoff: implementation commit `39437f6`, branch `feat/desktop-update-manifest-20261026`. Later publication requires explicit authorization, a newly selected version and live verification. If the release monitor is busy then, prepare a new immutable queue batch rather than edit/replay existing batches. The user subsequently authorized a new immutable queue entry.

## Execution record

- Planning: user-approved recommendation; implementation ran inline. Baseline frontend build hit sandbox spawn EPERM; a local execution outside the sandbox passed 65 tests.
- Final frontend validation: `npm run check`, 76/76 tests, TypeScript and production frontend build passed (`local-check.log`). `npm run test:platform` passed the existing Edge native-bridge fixture across four languages/eight pages (`platform-check.log`).
- Focused actual settings/bridge Edge smoke passed: checked-version download, a failed second check retaining the earlier version without raw exception text, Japanese language switch, and permanent manual link; no page errors (`browser-update-check.log`). Fixture and screenshot: sibling `.audit-tmp/desktop-update-manifest-20261026-validation/`.
- Native RED: the old parser rejected the new static manifest, confirmed in `red-native-harness.log`. Native GREEN: 9/9 direct-source updater/helper tests passed (`native-check.log`), including localhost HTTP fixtures and concurrent cache callers. The sibling validation crate uses the project Rust sources, reqwest blocking without TLS, and existing dependencies; it does not establish HTTPS handshake or whole-application acceptance.
- Whole application `cargo test --offline --manifest-path src-tauri/Cargo.toml` failed before app compilation because this machine's LLVM/MSVC setup links incompatible C objects (`_wcsdup`, `__stack_chk_guard` from vswhom/ring). Baseline evidence: `baseline-rust.log`. Run the original Windows MSVC CI checks and build before any release; do not treat the isolated tests as a complete EXE build.
- Full `cargo fmt --check` and `git diff --check` passed. No new dependencies or application version bump.
- Independent final review found one Important timing defect: using request-start time shortened the actual cooldown after slow failures. A failing test reproduced it (`red-cooldown.log`); response/completion clocks now drive Retry-After, default failure cooldown and successful check timestamps. All nine native tests then passed. Review's minor helper-document pointer was corrected. No deferred code findings.
- No remote writes, Release calls, live queue writes or cmd actions have been performed. The later user message "finish the work" prompted an asynchronous clarification about lifting the earlier explicit publication deferral; continue local completion while that answer is pending.

## Later authorized publication

1. Confirm that online publication is authorized, inspect current monitor/cmd and enabled queue state read-only, and reconcile the latest application/page source commits. This branch includes the pending page candidate at base `8793344`; preserve it when integrating.
2. Choose an unused stable application version (do not publish this work again as v0.2.0), synchronize package/package-lock, Cargo/Cargo.lock and Tauri versions, and run full Windows MSVC build/tests. A successful test fixture is not a release artifact.
3. Pin the audited source commit, ZIP and `desktop-update.json`; require the CI draft/read-back verification and post-publication latest/tag/asset verification. Existing v0.2.0 clients need one manual EXE replacement to get the new native checker.
4. If cmd has a current batch, prepare a new immutable batch and append through the established queue mechanism. Do not edit active/historical manifests or receipts, replay finished/uncertain batches, restart cmd merely to add a batch, or replace its current payload. A queue addition is not proof of publication.

## Authorized publication preparation, 2026-10-26

- User explicitly selected online publication and queuing, then authorized restarting the stopped cmd after diagnosis.
- The original `deck-card-announcements-20261025` stopped at 05:18 in desktop GitHub preflight, before durable launch intent. Read-only SSH confirmed no remote batch state, coordinator or lock; its manifest SHA matched. Authenticated GitHub and original queue preflight subsequently passed.
- Local monitor patch retries only GET transport failures and HTTP 500/502/503/504 at most three times. Writes retain one-attempt/reconciliation behavior; safe cause codes replace raw exception messages. Full monitor regression: 188/188. Original receipts archived, all 45 queue files unchanged, and original cmd restarted at 05:42 with monitor PID 28304. This is recovery of the already armed batch, not a new server launch.
- Release compatibility adds structured IPC rejection of unavailable/stale checks, so older cached pages cannot falsely announce current status. New pages preserve native last-good and retry timestamps. Both JS and native RED regressions reproduced the previous behavior; frontend release check passed 77/77. Native/CI validation and final queued batch evidence follow in the local release handoff.
