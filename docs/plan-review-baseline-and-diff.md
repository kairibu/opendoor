# Implementation Plan: Review Baseline — Commit After Review + "Changes Since Review" Diff

Add an opt-in **review→commit** pipeline to the paired backend (run `doorstop review <uid>`,
then record a pathspec-limited git commit of the item file with a conforming
`doorstop: review <uid>` message), and use that message as a fast **baseline pointer** for a
new `doorstop.item-baseline` backend operation that lets the Requirements panel's detail
pane show **what changed in an unreviewed item since its last review**.

---

## Background and rationale

- An item is "unreviewed changes" when its stored `reviewed` fingerprint
  (SHA-256 over uid, text, ref, references, sorted link UIDs, extended reviewed
  attributes — `computeItemStamp`, `src/doorstop-state.ts`) no longer matches the
  file content. The stamp carries **no timestamp and is non-invertible**, so the
  reviewed version of the item can only be recovered from **git history**.
- If the Review action first **commits** (or the review is followed immediately by a
  commit), the commit's blob content hashes **exactly to the stored `reviewed` stamp**
  (the `reviewed:` line itself is not part of the hashed content). That commit is the
  *review baseline* — the "before" side of the diff.
- **Why review-first, commit-after** (not commit-then-review):
  1. One **self-contained commit** per review cycle: text edits *and* the new
     `reviewed:` line land together — no dangling "reviewed but uncommitted stamp
     line" dirty state right after clicking Review.
  2. **Compatible with review-blocking pre-commit hooks** (Doorstop's own
     `hooks/check_unreviewed_requirements.sh` greps for "unreviewed changes" and
     exits 1): by commit time the file *is* reviewed, so such hooks pass. A
     commit-first order would deliberately commit unreviewed changes and get
     rejected by those repos.
- **Conforming commit message**: `doorstop: review <uid>` — single line,
  deterministic, and regex-anchorable, which turns "find the reviewed version" into
  a cheap `git log --grep` instead of a full stamp-walk of the file's history
  (the stamp-walk remains as the fallback for rewritten/squashed history).

## Architecture overview

### New backend operation

```
Review button (+commitAfterReview)
  → context.backend.request("doorstop.run", { op: "review", uid, commit: true })
      → server: doorstop review <uid>            (existing argv path)
      → server: git rev-parse / status / add / commit -- <item path>
      → response { op:"review", …CLI result…, commit: { status, sha?, stderr? } }
  → Last run section shows CLI output + commit outcome; panel auto-rescans

"Changes since review" section (detail pane, collapsed by default)
  → context.backend.request("doorstop.item-baseline", { uid, path })
      → server: git rev-parse; git log --grep="^doorstop: review <uid>$" -- <path>
        (zero hits → git log --max-count=50 -- <path>); git show <sha>:<path> per sha
      → response { git, source, candidates: [{ sha, blob }] }
  → browser: parse each blob (model chain), computeItemStamp until it matches
    item.reviewed → semantic diff vs current item
```

- Routing: the provider `request` currently rejects any `operation !== "doorstop.run"`
  (`src/doorstop-backend.ts:100`). It gains a dispatch on a second operation name.
- Both operations run inside the existing per-workspace serialization
  (`runSerialized`, `src/doorstop-backend.ts`) — a review+commit and a baseline
  fetch never overlap in one checkout.
- **Deadline budget**: the host bounds each provider callback to ~10 s. The
  review+commit pipeline tracks `startedAt` and gives every subsequent exec
  `min(settings.timeoutMs, remainingBudget)`; if the review consumed the budget,
  git steps are skipped with `status: "skipped"` (reason surfaced in Last run).

### Responsibilities

| Side | Module | Responsibility |
|---|---|---|
| Shared contract | `src/doorstop-backend-contract.ts` | `commit` field on the review request; `DoorstopCommitOutcome` on the response; new `DOORSTOP_BASELINE_OPERATION` + request/response types; safe-item-path validator shared by both ops; parse validators for all new shapes. |
| Server backend | `src/doorstop-backend.ts` | Review→commit pipeline (doorstop exec + git execs, deadline budget, non-fatal commit failures); baseline handler (grep, history fallback, blob fetch with size cap); `gitPath` settings. |
| Server entry | `src/server-plugin.ts` | Operation dispatch: `doorstop.run` → existing handler, `doorstop.item-baseline` → new handler. |
| Browser settings | `src/doorstop-settings.ts` | New `commitAfterReview` boolean in `.pi-web/opendoor.json` (default **false**). |
| Panel | `src/doorstop-panel-elements.ts`, `src/doorstop-panel-controller.ts` | Send `commit: settings.commitAfterReview` on review; render commit outcome in Last run; collapsible "Changes since review" section with lazy baseline fetch + per-item cache; semantic diff rendering. |
| New util | `src/doorstop-diff.ts` | LCS line diff (~40 lines; item texts are short) + semantic field compare (ref/references value compare, link-UID set diff, extended-attr value compare). |

---

## Plan

### Phase A — shared contract

1. **Extend `DoorstopRunRequest`** (`src/doorstop-backend-contract.ts`): the review
   variant becomes `{ op: "review"; uid: string; commit?: boolean }` — optional for
   backward compatibility with in-flight requests across a mixed-version reload
   window; absent/false behaves exactly as today.
2. **Add `DoorstopCommitOutcome` + response field**:
   ```ts
   export interface DoorstopCommitOutcome {
     /** committed → sha set; clean → file already committed; skipped → not a
      *  repo / review failed / deadline exhausted; failed → git error. */
     status: "committed" | "clean" | "skipped" | "failed";
     /** Abbreviated sha of the created commit ("committed" only). */
     sha?: string;
     /** Bounded stderr excerpt ("failed" only). */
     stderr?: string;
   }
   // DoorstopRunResponse gains:  readonly commit?: DoorstopCommitOutcome;
   ```
   `parseDoorstopRunResponse` accepts the optional field strictly (unknown fields
   rejected as today); `parseDoorstopRunRequest` validates `commit` as optional
   boolean.
3. **Add the baseline operation**:
   ```ts
   export const DOORSTOP_BASELINE_OPERATION = "doorstop.item-baseline"; // grammar ^[a-z][a-z0-9.-]*$
   export interface DoorstopBaselineRequest { uid: string; path: string }
   export interface DoorstopBaselineCandidate { sha: string; blob: string }
   export interface DoorstopBaselineResponse {
     /** false → not a git repository; candidates is empty. */
     git: boolean;
     /** "review-commit" → grep hits; "history" → generic log fallback; "none". */
     source: "review-commit" | "history" | "none";
     /** Newest first; each blob ≤ 256 KiB (oversize blobs are skipped server-side). */
     candidates: readonly DoorstopBaselineCandidate[];
   }
   export const DOORSTOP_BASELINE_GREP_LIMIT = 20;
   export const DOORSTOP_BASELINE_HISTORY_LIMIT = 50;
   export const DOORSTOP_BASELINE_BLOB_MAX = 256 * 1024;
   ```
4. **Add `isValidDoorstopItemPath(value)`** — the safe-relative-path rule the
   baseline request's `path` and the review commit pathspec must pass: non-empty,
   workspace-relative, no `..` segment, no backslash, no control characters,
   ≤ 256 chars, single line. Export it from the contract so browser and server
   validate identically (the UID grammar / `isValidPublishTarget` idiom).

### Phase B — server backend

5. **`src/doorstop-backend.ts` — review+commit pipeline.** When
   `request.input.commit === true`:
   - Record `startedAt`; run `doorstop review <uid>` via the existing
     `runDoorstop` with `timeoutMs = min(settings.timeoutMs, remaining)`.
   - If the review did not exit 0 (failed findings, killed, ENOENT) → return the
     plain review response **without** the commit field's attempt (commit outcome
     `skipped`) — a failed review must never be committed.
   - Otherwise run the git steps through a new `runGit` wrapper (same
     `context.execFile` call shape, `file = settings.gitPath`, same `unsetEnv`
     hygiene — git itself only needs a clean `GIT_*`-free env):
     1. `git rev-parse --is-inside-work-tree` — non-zero/empty → outcome
        `skipped` (not a repository).
     2. `git status --porcelain -- <path>` — empty → outcome `clean`.
     3. `git add -- <path>` then `git commit -m "doorstop: review <uid>" -- <path>`
        — the add is required because `git commit -- <path>` only accepts paths
        *known to git* (untracked new item files would fail). The pathspec-limited
        form records only the item file's working-tree content and leaves the
        user's other staged/unstaged WIP untouched.
     4. `git rev-parse --short HEAD` → outcome `committed` + sha.
   - Any git failure → outcome `failed` with a bounded stderr excerpt (echo cap
     ~2 KiB); the response still **resolves** — the review succeeded and its
     result stands; the commit outcome is narration, not infrastructure error
     (same philosophy as the truncation flags).
   - `git` missing (spawn ENOENT) → outcome `failed` with a "git not found"
     message (reuse the ENOENT mapping idiom).
6. **`src/doorstop-backend.ts` — baseline handler** `requestDoorstopBaseline(...)`:
   - Validate `{ uid, path }` (`isValidDoorstopUid`, `isValidDoorstopItemPath`);
     reject before any exec.
   - `git rev-parse --is-inside-work-tree` → `{ git: false }` response on failure.
   - `git log --max-count=20 --grep="^doorstop: review <uid>$" -- <path>` with
     `--format=%H`. Escape regex metacharacters in `uid` defensively (the UID
     grammar makes this a no-op today; the escape keeps the validator and the
     grep decoupled). Basic-regex mode gives us the `^…$` anchors that
     `--fixed-strings` cannot — and the anchors prevent the
     `REQ001`-matches-`REQ0012` substring trap.
   - Zero hits → `git log --max-count=50 --format=%H -- <path>` (generic history
     fallback; `source: "history"`), else `source: "review-commit"`.
   - Per sha: `git show <sha>:<path>` → blob; blobs over
     `DOORSTOP_BASELINE_BLOB_MAX` are skipped (not fatal). Return candidates
     newest-first.
7. **`src/doorstop-backend.ts` — settings.** Extend the lenient server settings
   parse with `gitPath` (string, default `"git"`; host-side
   `plugins.opendoor.settings` — same place `doorstopPath` lives). The *decision*
   to commit (`commit: true`) stays browser-side (workspace settings file), the
   server only validates the boolean — browser-driven policy, server-executed.
8. **`src/server-plugin.ts`** — dispatch on `request.operation`:
   `DOORSTOP_RUN_OPERATION` → `requestDoorstopBackend` (unchanged),
   `DOORSTOP_BASELINE_OPERATION` → `requestDoorstopBaseline`, anything else →
   the existing unsupported-operation error.

### Phase C — browser wiring

9. **`src/doorstop-settings.ts`** — add `commitAfterReview: boolean` to
   `OpendoorSettings` (default `false`, frozen in `DEFAULT_OPENDOOR_SETTINGS`);
   validate/normalize in `readOpendoorSettings` exactly like the existing fields
   (wrong type → warning diagnostic + default).
10. **`src/doorstop-panel-elements.ts`** — `reviewItem(item)` (line ~2020) reads
    the workspace settings already available to the panel and passes
    `commit: settings.commitAfterReview ? true : undefined` in the review
    request (omitted under the default so old servers parse it fine).
11. **Last run rendering** — when the response carries `commit`, append one line
    to the Last run section's meta:
    `commit: <short-sha>` / `commit: clean (already committed)` /
    `commit: skipped (not a git repository | review failed | deadline)` /
    `commit: failed — <stderr excerpt>`. Keep it informational; a failed commit
    does not change the run's ok/failed badge (the review itself succeeded).

### Phase D — "Changes since review" section

12. **`src/doorstop-diff.ts`** (new): `diffLines(before: string, after: string)`
    → `{ kind: "same" | "added" | "removed"; text: string }[]` via a plain LCS
    dynamic program (item texts are a few lines — no `diff` dependency; the
    `diff` package in node_modules is a transitive host dep and must not be
    imported). Plus `diffItemFields(before: ItemRecord, after: ItemRecord,
    config)` producing a semantic record: text diff, `ref` change,
    `references` change, added/removed **link UIDs**, changed extended
    reviewed-attribute values — exactly the field set the stamp covers.
13. **`src/doorstop-panel-controller.ts`** — baseline cache:
    `Map<uid, { key: string; view: BaselineView }>` where
    `key = item.reviewed + "\u0000" + currentStamp` — any re-review or further
    edit changes the key and misses naturally. The fetch sends
    `{ uid, path: item.path }` through `context.backend.request` and stamps
    candidates newest-first (`buildItemRecord` from the model chain + the
    document's config) until one matches `item.reviewed`.
14. **`src/doorstop-panel-elements.ts` — detail pane.** In `renderDetail`
    (line ~1685), between the state-chip row and the "Text" section, render a
    collapsible **"Changes since review"** section when
    `item.stateKeys.includes("unreviewed") && item.reviewed !== null` and the
    backend path is active (unpaired installs have no git access — the section
    is hidden there, consistent with the existing backend-absent fallbacks):
    - Collapsed by default (`<details>`); expanding triggers the lazy baseline
      fetch; while loading → muted "Loading baseline…"; no match →
      "Could not locate the reviewed version (history may have been rewritten)";
      `git: false` → "No git history — previous version unavailable".
    - Match → semantic diff view: text as line-level `+`/`−` rows, field-level
      chips for ref/references/links/extended attrs.
    - Styling reuses the chip/finding idiom: `--pi-success` (added) /
      `--pi-danger` (removed) with `color-mix(in srgb, … 9%, transparent)`
      backgrounds and `--pi-border-muted` separators — follows the host theme
      for free.
15. **`src/doorstop-contributions.ts`** — mirror the new controller state
    (baseline cache version counter / in-flight flag) into the body element
    properties, same pattern as `lastRun`/`runInProgress`.

### Phase E — docs

16. **`README.md`** and **`docs/feature-doorstop-plugin.md`**: new Review
    behavior (review→commit, message format, opt-in setting), the
    `doorstop.item-baseline` operation, the "Changes since review" pane, and a
    note in §12 that the review-commit message now provides the historical
    anchor that the deferred browser-side git parsing could not (baseline
    recovery runs server-side where git lives).

### Phase F — tests (vitest, `src/**/*.test.ts`)

17. **`src/doorstop-backend-contract.test.ts`** — review request with/without
    `commit`; `DoorstopCommitOutcome` strict parse (unknown status rejected);
    `DoorstopBaselineRequest`/`Response` happy + junk; `isValidDoorstopItemPath`
    (traversal, absolute, control chars, length).
18. **`src/doorstop-backend.test.ts`** — fake `execFile` recorder:
    - review with `commit: true` → exact argv sequence
      (`review uid` → `rev-parse` → `status` → `add` → `commit -m doorstop:
      review REQ001 -- path` → `rev-parse --short`), message format pinned;
    - clean file → no add/commit, outcome `clean`; non-repo → `skipped`;
      review exit ≠ 0 / killed → **no git exec at all**;
    - git failure → response resolves with `failed` + bounded stderr;
      git ENOENT → "git not found";
    - deadline: slow review (fake timer) → git steps skipped;
    - baseline: non-repo → `{ git: false }`; grep hit → `source:
      "review-commit"` with blobs in order; zero grep hits → history fallback
      capped at 50; oversize blob skipped; invalid uid/path rejected without exec;
    - `gitPath` setting honored; both ops serialized per workspace.
19. **`src/doorstop-settings.test.ts`** — `commitAfterReview` default false,
    accepted true/false, wrong type → warning + default.
20. **`src/doorstop-panel-elements.test.ts` / `doorstop-panel.test.ts`** —
    review request carries `commit` iff the setting is on; commit outcome line
    renders in Last run; "Changes since review" section gated on
    unreviewed+reviewed+backend; expand triggers exactly one baseline fetch
    (cache hit on second expand); stamp-match picks the right candidate;
    no-match and no-git notices; diff rendering (added/removed/unchanged rows,
    link added/removed chips) against fixture blobs.
21. **`src/doorstop-diff.test.ts`** (new) — LCS diff unit tests (identical,
    pure add, pure remove, interleaved, empty strings) and field-diff tests
    (link add/remove, ref change, extended attr change).

### Phase G — rollout

22. `npm run build && npm run typecheck && npm test`; rebuild bundles,
    `systemctl --user restart pi-web-sessiond.service`, reload the tab.
    Verify on a fixture doorstop project **inside a git repo**:
    enable `commitAfterReview` in `.pi-web/opendoor.json`, edit an item, Review
    → commit appears with the conforming message; open "Changes since review"
    on the *next* edit → the diff shows the exact edit; disable the setting →
    no commit; run in a non-git workspace → `skipped`/`git: false` notices;
    delete the review commit's message (`git commit --amend -m x`) → baseline
    falls back to the history walk and still matches by stamp.

---

## Files to modify

- `src/doorstop-backend-contract.ts` — review `commit` field, `DoorstopCommitOutcome`, baseline operation types/limits, `isValidDoorstopItemPath`, parse validators.
- `src/doorstop-backend.ts` — review→commit pipeline (`runGit`, deadline budget), baseline handler, `gitPath` settings, operation error message update.
- `src/server-plugin.ts` — operation dispatch on `request.operation`.
- `src/doorstop-settings.ts` — `commitAfterReview` workspace setting.
- `src/doorstop-panel-elements.ts` — commit flag on review, commit outcome line, "Changes since review" section + diff rendering.
- `src/doorstop-panel-controller.ts` — baseline fetch + per-item cache.
- `src/doorstop-contributions.ts` — mirror new controller state.
- `README.md`, `docs/feature-doorstop-plugin.md` — behavior, settings, §12 note.
- Test files listed in Phase F.

## New files

- `src/doorstop-diff.ts` — LCS line diff + semantic item-field diff.
- `src/doorstop-diff.test.ts` — its unit tests.

## Risks & open questions

- **Committing user content is policy-sensitive** — mitigated by default-off
  (`commitAfterReview: false`), explicit setting, pathspec-limited commit that
  never touches unrelated WIP, and the Last run narration of every commit.
- **10 s callback ceiling**: review + up to 5 git execs must share one callback.
  Deadline-based per-exec budgeting with skip-on-exhaustion; the existing 8.5 s
  doorstop default leaves ~1.5 s for git, which is ample for porcelain operations
  on a normal repo. *Open question: shave the doorstop exec to ~6 s when
  `commit` is requested so git gets ~3 s?*
- **Message-format drift** (user edits messages via amend/rebase, squash merges,
  or other tooling writes different messages) → grep misses → stamp-walk
  fallback still recovers the baseline; only cost is a bigger response.
- **History rewritten beyond the 50-commit history window** (very old unreviewed
  item, squashed everything) → no baseline → honest "could not locate" notice.
- **Concurrent edits between review and commit** (ms window): the commit
  snapshots the file as it is; if a stamp mismatch ever surfaces downstream, the
  history fallback covers it. Serialization prevents interleaved plugin runs
  but cannot stop a human editor.
- **`doorstop clear` also dirties the file** (rewrites link fingerprints) and is
  *not* committed by this plan — reviewing after clearing folds both changes
  into the review commit; the reverse order leaves a dirty stamp line.
  *Open question: give clear the same opt-in commit treatment later?*
- **Unpaired installs**: no backend → no commit, no diff section (terminal
  fallback users commit manually as today). The plan deliberately does not try
  to orchestrate multi-command terminal runs.
- **Non-`yml` item extensions** (if a workspace configures them): the item-path
  validator intentionally does not constrain the extension — pathspec safety
  comes from the relative-path grammar plus `execFile` argv (no shell) and the
  `--` separator (no option injection).
