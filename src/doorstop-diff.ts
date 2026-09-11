// ---------------------------------------------------------------------------
// Opendoor "Changes since review" diff utilities (plan Phase D step 12): the
// pure diff engine behind the detail pane's collapsible section. Two pieces:
//
//   - `diffLines(before, after)` — a line-level diff via plain LCS dynamic
//     programming (item texts are a few lines, so the O(n·m) DP is cheap; a
//     cell budget guards the pathological large-file case).
//     DELIBERATELY NO dependency on the `diff` package: it is a transitive
//     HOST dependency (the git/opense plugins import it), not a declared
//     dependency of this plugin — importing it here would couple the plugin's
//     bundle and tests to a host-internal transitive.
//   - `diffItemFields(before, after, config)` — the SEMANTIC field diff: the
//     exact field set `computeItemStamp` (src/doorstop-state.ts) hashes —
//     text, ref, references, link UIDs, and the extended reviewed attributes
//     of the owning document config. A stamp mismatch means at least one of
//     these differs, so the field diff is what the section renders: text as
//     `+`/`−` line rows, everything else as before→after field chips.
//
// Both functions are pure and DOM-free (node and browser bundles alike), so
// the controller can diff a fetched baseline blob against the current item
// with zero side effects and tests can pin the LCS semantics exhaustively.
// ---------------------------------------------------------------------------

import type { DoorstopDocumentConfig, DoorstopItemReference, ItemRecord } from "./doorstop-contract.js";
import { compareDoorstopUids, doorstopConvertToStr, reviewedAttributeNames } from "./doorstop-state.js";

/** One line of a line-level diff (LCS output, in input order). */
export interface DiffLine {
  /** "same" — present in both texts; "added" — only in `after`;
   *  "removed" — only in `before`. */
  kind: "same" | "added" | "removed";
  text: string;
}

/** Cell budget of the LCS dynamic program (`n × m`). The BASELINE blob is
 *  capped server-side at 256 KiB (~8k lines), but the CURRENT item's text is
 *  bounded only by the host file-size cap (~2 MiB ≈ 65k lines) — an
 *  uncapped O(n·m) DP would allocate an (n+1)×(m+1) number table in the
 *  multi-GB range and freeze/OOM the tab. Past this budget the line diff is
 *  skipped (`diffLines` returns `undefined`) and the renderer shows a
 *  "text changed" notice instead. 250k cells covers e.g. a 1000 × 250 or
 *  500 × 500 line comparison — far beyond any real item body. */
export const DIFF_LINES_MAX_CELLS = 250_000;

/**
 * Line-level LCS diff of two texts. `before`/`after` are split on newlines;
 * an EMPTY string is zero lines (the model chain's `loadText` normalization
 * never produces a bare `""` line, and an empty-before/empty-after diff must
 * render nothing, not one phantom row). Rows come out in input order with
 * the classic LCS tie-break (removals before additions on ambiguity) — the
 * exact shape the detail pane renders as `+`/`−` rows.
 *
 * Returns `undefined` when the texts EXCEED the {@link DIFF_LINES_MAX_CELLS}
 * budget — the O(n·m) DP would allocate an (n+1)×(m+1) number table, which
 * is unpayable in the main thread for very large item files. Renderers
 * treat that as a "text changed — too large to diff" notice, never as an
 * empty diff (an empty-but-diffable text is `[]`).
 */
export function diffLines(before: string, after: string): DiffLine[] | undefined {
  // Empty text is zero lines: neither side can contain the phantom "" line
  // (loadText strips leading/trailing blank lines; text is never "\\n").
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // Guard BEFORE allocating the DP — `n × m` is the table's exact cell
  // count, so the check is both precise and allocation-free.
  if (a.length * b.length > DIFF_LINES_MAX_CELLS) return undefined;
  const rows = lcsRows(a, b);
  return rows.map((entry) => {
    if (entry.kind === "same") return { kind: "same", text: a[entry.index]! };
    if (entry.kind === "removed") return { kind: "removed", text: a[entry.index]! };
    return { kind: "added", text: b[entry.index]! };
  });
}

/** LCS walk result: per row, the kind and the SOURCE index on that side
 *  (removed/same index into `a`, added index into `b`). */
type LcsRow = { kind: "same" | "added" | "removed"; index: number };

/**
 * The LCS dynamic program + backtrack. `dp[i][j]` = LCS length of
 * `a[i..]`/`b[j..]`; the walk prefers a match, then removal (ties), then
 * addition — matching the classic LCS diff layout (removals stack before
 * their replacing additions). O(n·m) time and memory; item texts are a few
 * lines, so no Hirschberg optimization is warranted.
 */
function lcsRows(a: readonly string[], b: readonly string[]): LcsRow[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: LcsRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", index: i });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "removed", index: i });
      i++;
    } else {
      out.push({ kind: "added", index: j });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: "removed", index: i });
    i++;
  }
  while (j < m) {
    out.push({ kind: "added", index: j });
    j++;
  }
  return out;
}

/**
 * The semantic "what changed since the reviewed baseline" record — one field
 * per stamp input (`computeItemStamp`, src/doorstop-state.ts) so a stamp
 * mismatch always has at least one visible entry and no change is invisible.
 */
export interface ItemFieldDiff {
  /** `text` line diff (before → after); `undefined` when the texts exceed
   *  the LCS cell budget (renderers show a "text changed" notice instead of
   *  rows — an empty-but-diffable text is `[]`, never `undefined`). */
  text: DiffLine[] | undefined;
  /** `ref` change (a `""` side means "no single reference" there); absent
   *  when unchanged. */
  ref?: { before: string; after: string };
  /** `references` change; absent when the lists serialize identically. */
  references?: {
    before: readonly DoorstopItemReference[];
    after: readonly DoorstopItemReference[];
  };
  /** Link UIDs present only in `after` (sorted; rendered as added chips). */
  linksAdded: readonly string[];
  /** Link UIDs present only in `before` (sorted; rendered as removed chips). */
  linksRemoved: readonly string[];
  /** Changed EXTENDED REVIEWED attribute values (the document's configured
   *  `attributes.reviewed` names only — the exact set the stamp hashes),
   *  in config order; `before`/`after` `undefined` means the attribute was
   *  absent on that side. */
  extended: readonly { name: string; before: unknown; after: unknown }[];
}

/**
 * Semantic field diff of two item records under one document config — the
 * exact field set `computeItemStamp(before, config)` vs
 * `computeItemStamp(after, config)` covers: text (line diff), ref, the
 * references list, the link-UID set, and the extended reviewed attribute
 * values. `before` is the baseline (the blob matched by stamp), `after` the
 * current item; caller ensures the two stamps differ (the section is gated
 * on the unreviewed state).
 */
export function diffItemFields(
  before: ItemRecord,
  after: ItemRecord,
  config: DoorstopDocumentConfig,
): ItemFieldDiff {
  // Link UIDs: raw-UID set comparison — exactly what the stamp hashes (the
  // sorted link UIDs), so a reorder-only change reads as unchanged while a
  // real add/remove surfaces. Sorted output for stable rendering in the
  // stamp's own order (`compareDoorstopUids`, the sort behind
  // sortLinkRecords) so the chips read the same way the fingerprint did.
  const beforeLinks = linkUidSet(before);
  const afterLinks = linkUidSet(after);
  const linksAdded: string[] = [];
  const linksRemoved: string[] = [];
  for (const uid of afterLinks) {
    if (!beforeLinks.has(uid)) linksAdded.push(uid);
  }
  for (const uid of beforeLinks) {
    if (!afterLinks.has(uid)) linksRemoved.push(uid);
  }
  linksAdded.sort(compareDoorstopUids);
  linksRemoved.sort(compareDoorstopUids);

  // Extended reviewed attributes: only the NAMES the document configures
  // (`reviewedAttributeNames` — the stamp's `for name ... if value !==
  // undefined` loop), compared with the stamp's own serialization so a
  // change means the fingerprint changed, never a no-op cosmetic diff.
  const extended: { name: string; before: unknown; after: unknown }[] = [];
  for (const name of reviewedAttributeNames(config)) {
    const beforeValue = before.attributes[name];
    const afterValue = after.attributes[name];
    if (beforeValue === undefined || afterValue === undefined) {
      // Presence change (attribute added or removed) is a fingerprint change.
      if (beforeValue === afterValue) continue;
    } else if (doorstopConvertToStr(beforeValue) === doorstopConvertToStr(afterValue)) {
      continue;
    }
    extended.push({ name, before: beforeValue, after: afterValue });
  }

  const diff: ItemFieldDiff = {
    text: diffLines(before.text, after.text),
    linksAdded,
    linksRemoved,
    extended,
  };
  if (before.ref !== after.ref) diff.ref = { before: before.ref, after: after.ref };
  if (serializeReferences(before.references) !== serializeReferences(after.references)) {
    diff.references = {
      before: before.references === undefined ? [] : before.references,
      after: after.references === undefined ? [] : after.references,
    };
  }
  return diff;
}

/** The links of an item as a raw-UID set (deduplicated — the model chain
 *  already dedups by canonical UID, so raw duplicates cannot occur). */
function linkUidSet(item: ItemRecord): Set<string> {
  return new Set(item.links.map((link) => link.uid));
}

/** Reference serialization for equality: stable even though `keyword`/`sha`
 *  are optional (undefined keys drop on both sides equally). */
function serializeReferences(references: ItemRecord["references"]): string {
  return JSON.stringify(references === undefined ? [] : references);
}