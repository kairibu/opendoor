// ---------------------------------------------------------------------------
// Pure prompt builders for the opendoor "Ask the agent" menu (feature spec
// §7.3). No DOM, no host API, no file reads: each builder takes the concrete
// contract records the caller already resolved (`ItemRecord`s, or a plain
// document prefix) and returns a self-contained instruction string an agent
// can act on with its own tools — exact relative file paths and backticked
// `doorstop` commands included, no panel context assumed. Mirrors the
// opense-prompts.ts idiom (pure string-in/string-out functions).
//
// Degradation & enforcement policy:
//   - fixSuspectLinksPrompt THROWS a TypeError when no changed parents are
//     passed: the scenario is contradictory without them (an item's suspect
//     links ARE its changed parents), so a silent no-op string would mislead
//     the agent. Every passed parent must also be one of the item's declared
//     links.
//   - draftChildRequirementPrompt THROWS a TypeError for a blank childPrefix:
//     `doorstop add` needs the target document's prefix, so there is nothing
//     actionable to prompt without it.
//   - explainItemPrompt degrades to its data: an item without parent links
//     gets an ask about why it declares none — but only when the absence is
//     not expected (derived and non-normative items don't need parent links,
//     hence no question is put to the agent). reviewReadinessPrompt names the
//     children the caller resolves from the index's reverse map, or defers
//     child-link coverage to the `doorstop` run when none are passed; an item
//     without references gets no reference list to verify.
// ---------------------------------------------------------------------------

import type { ItemRecord } from "./doorstop-contract.js";

/** "A", "B", "C" → "A, B and C" (single element → that element; empty → ""). */
function andJoin(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1] ?? ""}`;
}

/**
 * Explain — "Read `reqs/srd/REQ002.yml` (doorstop requirement REQ002) and
 * explain what it requires and why it links to REQ001" (spec §7.3). The
 * parent-UID clause comes from the item's own recorded links; an item with
 * no links is asked to assess whether that is correct — except derived and
 * non-normative items, where the absence is expected by construction
 * (contract §6's no-links chip applies only to normative, non-derived,
 * non-top-level items) and so is not put in question.
 */
export function explainItemPrompt(item: ItemRecord): string {
  const parents = item.links.map((link) => link.uid);
  if (parents.length === 0) {
    let kind: string | undefined;
    if (item.derived && !item.normative) kind = "derived, non-normative";
    else if (item.derived) kind = "derived";
    else if (!item.normative) kind = "non-normative";
    const linkClause = kind
      ? `It declares no parent links, which is expected for a ${kind} item`
      : `It declares no parent links — assess whether that is correct for its place in the ` +
        `${item.documentPrefix} document tree, and what should change if anything`;
    return (
      `Read \`${item.path}\` (doorstop requirement ${item.uid}) and explain what ${item.uid} requires. ` +
      `${linkClause}. Flag empty or ambiguous text.`
    );
  }
  return (
    `Read \`${item.path}\` (doorstop requirement ${item.uid}) and explain what ${item.uid} requires and why ` +
    `it links to ${andJoin(parents)}. Quote the text your explanation rests on; flag empty or ambiguous ` +
    `text and any parent link that looks wrong.`
  );
}

/**
 * Fix suspect links — "${item.uid} has suspect links to ${parents}: the
 * parent requirements changed after review; compare texts, propose updated
 * child text, then run `doorstop clear <uid>`" (spec §7.3). `parents` are the
 * linked items whose recorded fingerprints no longer match their current
 * fingerprints (the state chain's suspect-link comparison); each is named
 * with its workspace path so the agent can read it.
 *
 * @throws TypeError when `parents` is empty or contains an item that is not
 *   one of `item.links` — the caller resolved the changed parents already,
 *   so an empty/foreign list is a caller bug, not a prompt to emit.
 */
export function fixSuspectLinksPrompt(item: ItemRecord, parents: readonly ItemRecord[]): string {
  if (parents.length === 0) {
    throw new TypeError(
      "fixSuspectLinksPrompt requires at least one changed parent item: an item's suspect links are its changed parents, so an empty list has nothing to prompt about",
    );
  }
  const linkedUids = new Set(item.links.map((link) => link.uid));
  const unlinked = parents.filter((parent) => !linkedUids.has(parent.uid));
  if (unlinked.length > 0) {
    throw new TypeError(
      `fixSuspectLinksPrompt parents must be links of ${item.uid}: ${andJoin(unlinked.map((parent) => parent.uid))} ${unlinked.length === 1 ? "is" : "are"} not among ${item.uid}'s links`,
    );
  }
  const parentItems = andJoin(
    parents.map((parent) => `${parent.uid} (\`${parent.path}\`)`),
  );
  if (parents.length === 1) {
    return (
      `${item.uid} has a suspect link to ${parents[0]?.uid}: the recorded fingerprint no longer matches ` +
      `because that parent changed after ${item.uid} was last reviewed. Read \`${item.path}\` and ` +
      `${parentItems}, compare the two texts, and propose updated text for ${item.uid} that still traces ` +
      `correctly to the changed parent. Then run \`doorstop clear ${item.uid}\` in the workspace root to ` +
      `re-record the parent's current fingerprint, and run \`doorstop\` to confirm the suspect link is gone.`
    );
  }
  return (
    `${item.uid} has suspect links to ${andJoin(parents.map((parent) => parent.uid))}: the recorded ` +
    `fingerprints no longer match because those parents changed after ${item.uid} was last reviewed. ` +
    `Read \`${item.path}\` and the changed parents (${parentItems}), compare the texts, and propose ` +
    `updated text for ${item.uid} that still traces correctly to every changed parent. Then run ` +
    `\`doorstop clear ${item.uid}\` in the workspace root to re-record the parents' current ` +
    `fingerprints, and run \`doorstop\` to confirm no suspect link remains.`
  );
}

/**
 * Draft child requirement — "Draft a new TST item tracing to REQ003, run
 * `doorstop add TST`, link it with `doorstop link <new-uid> REQ003`, and fill
 * the text" (spec §7.3). `parent` is the requirement the new child must trace
 * to; `childPrefix` is the prefix of the child document the new item goes
 * into (`doorstop add` names the document by prefix). The new UID is unknown
 * until `doorstop add` runs, so the prompt carries the `<new-uid>` placeholder
 * and says to substitute the printed UID.
 *
 * @throws TypeError when `childPrefix` is blank — there is no document to add
 *   to, hence nothing actionable to prompt.
 */
export function draftChildRequirementPrompt(parent: ItemRecord, childPrefix: string): string {
  if (childPrefix.trim() === "") {
    throw new TypeError(
      "draftChildRequirementPrompt requires a non-empty child document prefix: `doorstop add` names its document by prefix",
    );
  }
  return (
    `Draft a new ${childPrefix} requirement that traces to ${parent.uid} (\`${parent.path}\`). ` +
    `Run \`doorstop add ${childPrefix}\` in the workspace root and note the UID it prints for the new ` +
    `item. Link the new item to its parent with \`doorstop link <new-uid> ${parent.uid}\`, substituting ` +
    `the printed UID for <new-uid>. Then fill in the new item's text so it elaborates ${parent.uid} at ` +
    `${childPrefix} level, referencing any relevant files (prefer \`doorstop edit <new-uid>\` when available, ` +
    `otherwise edit the item file the add command created — doorstop normalizes formatting on the next ` +
    `command run). Finally run \`doorstop\` in the workspace root and confirm the new item introduces no ` +
    `WARNING or ERROR before judging whether it is ready for \`doorstop review <new-uid>\`.`
  );
}

/** Workspace-root-relative file references of an item (ref + references). */
function referencePaths(item: ItemRecord): string[] {
  const paths = item.references?.map((reference) => reference.path) ?? [];
  return item.ref === "" ? paths : [item.ref, ...paths];
}

/**
 * Review readiness — "Check REQ005 against its child links and references
 * and tell me if it is ready for `doorstop review`" (spec §7.3). The prompt
 * enumerates the data the item itself carries (parent links, reference
 * paths, empty text) plus the child links the caller resolves from the
 * index's reverse map (`childrenByUid`) — so the spec's "child links" are
 * named explicitly when known — and delegates the tree-scoped half the item
 * record cannot see (items that *should* link to it but do not, and the
 * exact suspect/unknown-link verdicts) to `doorstop` validation, which is
 * authoritative for it.
 *
 * Degradation: when the caller passes no children (`[]`), the checklist
 * defers child-link coverage to the `doorstop` run below instead of
 * inventing facts about links it cannot see.
 */
export function reviewReadinessPrompt(item: ItemRecord, children: readonly ItemRecord[] = []): string {
  const parents = andJoin(item.links.map((link) => link.uid));
  const references = referencePaths(item);
  const childLinks = andJoin(
    children.map((child) => `${child.uid} (\`${child.path}\`)`),
  );
  const facts = [
    item.text.trim() === "" ? "its text is empty (that alone blocks review)" : "its text is filled in",
    item.links.length === 0
      ? "it declares no parent links"
      : `its recorded parent links (${parents}) are not suspect or missing a fingerprint`,
    children.length === 0
      ? "its child links are left to the `doorstop` run below"
      : `its child links are declared (${childLinks})`,
    references.length === 0
      ? "it has no file references to verify"
      : `its file references exist (${references.map((path) => `\`${path}\``).join(", ")})`,
  ];
  return (
    `Check whether ${item.uid} is ready for \`doorstop review ${item.uid}\`. Read \`${item.path}\` and ` +
    `verify that ${facts.join("; ")}. Then run \`doorstop\` in the workspace root and weigh any WARNING ` +
    `or ERROR it reports about ${item.uid} (for example a requirement that should link to ${item.uid} ` +
    `but does not). Report a verdict, and if ${item.uid} is not ready, the exact fixes to make first.`
  );
}

/**
 * Workspace-level validate — "run `doorstop` in the workspace root and
 * explain every WARNING/ERROR and how to fix it". Takes no data: it is the
 * whole-tree counterpart of the per-item builders.
 */
export function validatePrompt(): string {
  return (
    `Run \`doorstop\` in the workspace root and read its validation output. Explain every WARNING and ` +
    `ERROR it reports: what the message means, which item or document it concerns, and how to fix it ` +
    `(with \`doorstop link\`, \`doorstop clear\`, \`doorstop unlink\`, \`doorstop edit\`, or a direct ` +
    `edit of the item's file). Confirm the tree validates cleanly afterwards.`
  );
}
