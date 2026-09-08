#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-only
# ---------------------------------------------------------------------------
# opendoor fixture generator — STATE module (src/doorstop-state.ts).
#
# Generates src/doorstop-state.fixtures.json: a small Doorstop workspace whose
# per-item fingerprints were computed by REAL Doorstop (`Item.stamp()` /
# `Item.stamp(links=True)`), so the vitest suites can assert byte-for-byte
# serialization fidelity of the browser-side port.
#
# REGENERATE (requires network the first time, for pip):
#
#   python3 -m venv /tmp/doorstop-fixture-venv
#   /tmp/doorstop-fixture-venv/bin/pip install doorstop
#   # upgrade to the ground-truth upstream source (used here; the PyPI
#   # release's validator predates `include_inactive` link-target handling):
#   /tmp/doorstop-fixture-venv/bin/pip install --force-reinstall --no-deps \
#       /tmp/pi-github-repos/15eb8464f00e51c388c96dfb0bb2d0721d8dd20259cc0437db47572ba0dce88e
#   /tmp/doorstop-fixture-venv/bin/python notes/fixture-generator.py
#
# (uses $DOORSTOP_WS or /tmp/doorstop-fixture-ws as the sandbox workspace;
#  it is wiped and rebuilt on every run)
#
# Scenarios covered (deliberately overlapping, mirrors feature docs §6):
#   REQ001  plain item, reviewed, then text EDITED after review -> the review
#           stamp goes stale ("unreviewed changes" + suspect-recipient).
#   REQ002  item with text + ref to an existing file, reviewed clean.
#   REQ003  links to REQ001 + REQ002 recorded via clear() (both parents),
#           no child links -> no-child-links; REQ001 edit makes its link
#           suspect.
#   REQ004  item with `references` entries (one found file+keyword+sha, one
#           missing file -> missing-reference) and a NON-reviewed extended
#           attribute (`owner`) that must NOT participate in fingerprints.
#   REQ005  extended reviewed attributes `type` + `verification-method`,
#           configured (scrambled + duplicated) in the root .doorstop.yml
#           `attributes.reviewed`; reviewed clean -> chip "reviewed".
#   REQ006  links to REQ005 + TST001 (cross-prefix link-order sort).
#   REQ007  non-normative (heading), empty text, links to REQ001 ->
#           "non-normative, but has links" + doorstop "no text".
#   REQ008  inactive -> skipped by validation entirely.
#   TST001  child of REQ; link to REQ001 recorded pre-edit -> suspect.
#   TST002  child of REQ; no links -> "no-links".
#   TST003  child of REQ; derived, no links -> NO "no-links".
#   TST004  child of REQ; link to unknown UID REQ999 -> "unknown-link".
#   TST005  child of REQ; link to inactive REQ008 -> INFO "linked to
#           inactive item".
#   TST006  child of REQ; link to non-normative REQ007 -> WARNING "linked to
#           non-normative item".
#
# The REQ document lives at the WORKSPACE ROOT (directoryPath ""), so the
# reference paths written in the item files ("docs/refs/...") are root-
# relative, exactly as real Doorstop projects store them: Doorstop hashes the
# stored strings verbatim, the model chain's resolution is identity for a
# root-level document, and `knownFilePaths` contains the same paths — the
# fixtures are byte-consistent across all three views.
#
# Emitted JSON per item mirrors the plugin ItemRecord consumed by
# computeItemStamp/computeItemStates as built by the model chain:
# uid/documentPrefix/path/level/active/derived/normative/header/text/ref/
# references/links(fingerprint|null)/attributes(extended)/reviewed plus the
# two REAL Doorstop stamps and the item's final on-disk YAML.  `issues` holds
# Doorstop's own validator issues (severity + message) captured with
# settings REFORMAT=False / REVIEW_NEW_ITEMS=False for the severity-pinning
# tests.  `knownFilePaths` is the workspace file index (same shape the
# discovery walk would produce) backing the missing-reference chip.
#
# `schemaGap` pins REAL Doorstop serializations (`_convert_to_str` +
# `Stamp.digest` over the base empty item RQ001) for extended reviewed
# attribute scalars at the YAML 1.1/1.2 typing boundary — PyYAML in Doorstop
# vs js-yaml in the model chain.  Each entry carries the documented `parity`
# of the port (kept in sync with src/doorstop-state.test.ts): "equal"
# reproduces the entry byte-for-byte today, "divergent" is a type collapse
# the JS value the model chain hands over cannot carry (integral floats,
# `yes`, non-UTC timestamps).
# ---------------------------------------------------------------------------

import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "src", "doorstop-state.fixtures.json")
WS = os.environ.get("DOORSTOP_WS", "/tmp/doorstop-fixture-ws")

REF_FILE = "docs/refs/spec.txt"      # existing workspace file, also referenced
CHECK_FILE = "docs/refs/check.txt"   # existing workspace file, keyword-referenced
MISSING_FILE = "docs/refs/missing.md"  # intentionally not created

# Reference paths are ROOT-RELATIVE ("docs/refs/...") exactly as real
# Doorstop projects store them: the REQ document sits at the workspace root,
# so the stored string, the plugin's root-relative normalized path, and the
# `knownFilePaths` index entry are all identical — one coherent path in every
# view.  spec.txt is found by Doorstop's content search (its first line is
# its own path); check.txt by file path + keyword in find_file_reference;
# missing.md exists only as a reference.
REF_STR = "docs/refs/spec.txt"
CHECK_STR = "docs/refs/check.txt"
MISSING_STR = "docs/refs/missing.md"


def fmt_yaml_item(uid, text="", ref="", references=None, links=None, extra=None,
                  level="1.0", normative=True, active=True, derived=False,
                  header="", reviewed=None):
    """Canonical doorstop-style item YAML (yaml itemformat)."""
    lines = []
    for key, value in [
        ("active", active), ("derived", derived), ("header", header),
        ("level", level), ("links", links if links is not None else []),
        ("normative", normative), ("ref", ref),
    ]:
        if isinstance(value, bool):
            lines.append("{}: {}".format(key, "true" if value else "false"))
        elif isinstance(value, (int, float)):
            lines.append("{}: {}".format(key, value))
        elif value == "":
            lines.append("{}: ''".format(key))
        else:
            lines.append("{}: {}".format(key, value))
    if reviewed is not None:
        lines.append("reviewed: {}".format(reviewed))
    lines.append("text: |" if text else "text: ''")
    if text:
        for ln in text.split("\n"):
            lines.append("  " + ln)
    if references is not None:
        lines.append("references:")
        for r in references:
            lines.append("- type: {}".format(r["type"]))
            lines.append("  path: {}".format(r["path"]))
            if "keyword" in r:
                lines.append("  keyword: {}".format(r["keyword"]))
            if "sha" in r:
                lines.append("  sha: {}".format(r["sha"]))
    for key, value in (extra or {}).items():
        lines.append("{}: {}".format(key, value))
    return "\n".join(lines) + "\n"


def fmt_doc_config(prefix, parent, dirpath, reviewed=None):
    lines = ["settings:", "  digits: 4", "  prefix: {}".format(prefix),
             "  sep: ''", "  itemformat: yaml"]
    if parent:
        # Doorstop omits `parent` for root documents (create writes no key)
        lines.insert(-1, "  parent: {}".format(parent))
    if reviewed:
        lines.append("attributes:")
        lines.append("  reviewed:")
        for name in reviewed:
            lines.append("  - {}".format(name))
    return "\n".join(lines) + "\n"


def schema_gap_pins():
    """Real-Doorstop serializations for extended reviewed attribute scalars at
    the YAML 1.1/1.2 typing boundary (PyYAML in Doorstop vs js-yaml in the
    model chain).  Each pin hashes the base empty item RQ001 with the value as
    a single configured extended reviewed attribute, exactly like the embedded
    unit vectors in doorstop-state.test.ts.  `parity` is the documented PORT
    behavior (kept in sync with src/doorstop-state.test.ts): "equal"
    reproduces this serialization byte-for-byte today, "divergent" is a type
    collapse the JS value the model chain hands over cannot carry."""
    # pylint: disable=import-outside-toplevel
    import datetime

    from doorstop.core.item import _convert_to_str
    from doorstop.core.types import Stamp

    base = ["RQ001", "", ""]

    def pin(key, scalar, value, parity):
        converted = _convert_to_str(value, "")
        return {
            "key": key,
            "scalar": scalar,
            "parity": parity,
            "doorstopConvert": converted,
            "doorstopStamp": Stamp.digest(*(base + [converted])),
        }

    utc = datetime.timezone.utc
    return [
        pin("int-5", "YAML `5` (int)", 5, "equal"),
        pin("float-5.0", "YAML `5.0` — PyYAML float, but js-yaml yields the JS number 5", 5.0, "divergent"),
        pin("float-1e2", "YAML `1e2` — PyYAML float 100.0, js-yaml yields the JS number 100", 100.0, "divergent"),
        pin("bool-yes", "YAML `yes` — PyYAML bool True, js-yaml keeps the string 'yes'", True, "divergent"),
        pin("str-date", "quoted string '2024-01-01' — str on both sides", "2024-01-01", "equal"),
        pin("date", "YAML `2024-01-01` — PyYAML datetime.date; the port renders midnight-UTC JS Dates as date", datetime.date(2024, 1, 1), "equal"),
        pin("datetime", "YAML `2024-01-01 12:34:56Z` — PyYAML datetime(utc); the port renders UTC datetimes with '+00:00'", datetime.datetime(2024, 1, 1, 12, 34, 56, tzinfo=utc), "equal"),
        pin("datetime-ms", "YAML `2024-01-01 12:34:56.123Z` — fractional seconds become microseconds", datetime.datetime(2024, 1, 1, 12, 34, 56, 123000, tzinfo=utc), "equal"),
        pin("datetime-tz", "YAML `2024-01-01 12:34:56+02:00` — js-yaml normalizes to a UTC Date; the offset is lost", datetime.datetime(2024, 1, 1, 12, 34, 56, tzinfo=datetime.timezone(datetime.timedelta(hours=2))), "divergent"),
        pin("nan", "YAML `.nan` — PyYAML float nan; the port emits 'nan'", float("nan"), "equal"),
        pin("inf", "YAML `.inf` — PyYAML float inf; the port emits 'inf'", float("inf"), "equal"),
        pin("neg-inf", "YAML `-.inf` — PyYAML float -inf; the port emits '-inf'", float("-inf"), "equal"),
    ]


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def main():
    try:
        import doorstop  # noqa: F401
        from doorstop import settings
        from doorstop.core.builder import build
        from doorstop.core.validators.item_validator import ItemValidator
    except ImportError as exc:
        print("ERROR: real Doorstop is required to regenerate fixtures: {}".format(exc))
        print("Run: python3 -m venv /tmp/doorstop-fixture-venv && "
              "/tmp/doorstop-fixture-venv/bin/pip install doorstop")
        sys.exit(1)

    # --- (re)create the sandbox workspace ---------------------------------
    if os.path.isdir(WS):
        shutil.rmtree(WS)
    os.makedirs(WS)
    # Doorstop needs a working copy for tree/vcs operations; the vcs helpers
    # run git with the process cwd, so chdir into the sandbox first.
    import subprocess
    subprocess.run(["git", "init", "-q", WS], check=False)
    os.chdir(WS)

    # configs first — REQ lives at the workspace root so reference paths are
    # root-relative and identity-resolved by the model chain
    write(os.path.join(WS, ".doorstop.yml"),
          fmt_doc_config("REQ", "", ".",
                         # scrambled + duplicated on purpose: Doorstop sorts
                         # and deduplicates (Document: sorted(set(...)))
                         reviewed=["verification-method", "type", "type"]))
    write(os.path.join(WS, "tests", ".doorstop.yml"),
          fmt_doc_config("TST", "REQ", "tests"))

    # reference target files
    write(os.path.join(WS, REF_FILE), REF_STR + "\nthe spec\n")
    write(os.path.join(WS, CHECK_FILE), CHECK_STR + "\nCALIBRATE the sensor\n")

    def resolve(path, ref):
        """Port of the model chain's resolveRefPath: document-directory-relative
        reference -> workspace-root-relative (the knownFilePaths format)."""
        import posixpath
        parts = []
        for token in "{}/{}".format(path, ref).split("/"):
            if token in ("", "."):
                continue
            if token == "..":
                if parts:
                    parts.pop()
                continue
            parts.append(token)
        return posixpath.join(*parts)

    # initial item files (reviewed/links finalized via the API below)
    item_files = {
        "REQ001": fmt_yaml_item("REQ001", text="The system shall blink.\nIt shall use the light.",
                                level="1.0"),
        "REQ002": fmt_yaml_item("REQ002", text="The system shall beep.",
                                ref=REF_STR, level="1.0"),
        "REQ003": fmt_yaml_item("REQ003", text="The system shall track all signals.",
                                level="1.1"),
        "REQ004": fmt_yaml_item(
            "REQ004", text="The system shall verify itself.",
            references=[
                {"type": "file", "path": CHECK_STR, "keyword": "CALIBRATE",
                 "sha": "0123456789abcdef0123456789abcdef"},
                {"type": "file", "path": MISSING_STR},
            ],
            extra={"owner": "ops"}, level="1.1"),
        "REQ005": fmt_yaml_item("REQ005", text="The system shall log events.",
                                extra={"type": "functional",
                                       "verification-method": "test"},
                                level="1.2"),
        "REQ006": fmt_yaml_item("REQ006", text="The system shall report status.",
                                level="1.2"),
        "REQ007": fmt_yaml_item("REQ007", text="", normative=False, level="2.0",
                                links=["REQ001"]),
        "REQ008": fmt_yaml_item("REQ008", text="Temporarily disabled.", active=False,
                                level="3.0"),
        "TST001": fmt_yaml_item("TST001", text="Verify blinking.", level="1.0"),
        "TST002": fmt_yaml_item("TST002", text="Verify beeping.", level="1.0"),
        "TST003": fmt_yaml_item("TST003", text="Verify tracking.", derived=True,
                                level="1.1"),
        "TST004": fmt_yaml_item("TST004", text="Verify unknown parent.",
                                links=["REQ999"], level="1.1"),
        "TST005": fmt_yaml_item("TST005", text="Verify inactive target.",
                                links=["REQ008"], level="1.2"),
        "TST006": fmt_yaml_item("TST006", text="Verify heading target.",
                                links=["REQ007"], level="1.2"),
    }
    for uid, content in item_files.items():
        doc = "." if uid.startswith("REQ") else "tests"
        write(os.path.join(WS, doc, uid + ".yml"), content)

    # --- first tree: record links/set reviewed via the real API -----------
    tree = build(cwd=WS, root=WS)

    def uid_item(uid, tree=tree):
        return tree.find_item(uid)

    # record link fingerprints (clear() stores each parent's current
    # stamp() into our links and saves the item file)
    links_to_record = {
        "REQ003": ["REQ001", "REQ002"],  # written in reverse order -> sorts
        "REQ005": ["REQ002"],
        "REQ006": ["TST001", "REQ005"],  # cross-prefix: REQ005 < TST001
        "TST001": ["REQ001"],
    }
    for uid, parents in links_to_record.items():
        item = uid_item(uid)
        item.links = parents
        item.clear()

    # review REQ001 + REQ002 + REQ005 (reviewed = stamp(links=True), saved)
    for uid in ("REQ001", "REQ002", "REQ005"):
        uid_item(uid).review()

    # --- now EDIT REQ001 (after its own review AND after children cleared):
    # keeps a stale `reviewed` stamp on REQ001 and stale recorded link
    # fingerprints in REQ003/TST001 -> suspect links.
    req001 = uid_item("REQ001")
    req001.text = "The system shall flash.\nIt shall use the light."
    req001.save()

    # --- final tree (re-read everything from disk) ------------------------
    tree = build(cwd=WS, root=WS)

    # per-item Doorstop validator issues, with auto-review/reformat off so the
    # captured issues reflect the exact on-disk state
    settings.REFORMAT = False
    settings.REVIEW_NEW_ITEMS = False

    def json_value(v):
        if isinstance(v, (str, bool)) or v is None or isinstance(v, (int, float)):
            return v
        if isinstance(v, list):
            return [json_value(e) for e in v]
        if isinstance(v, dict):
            return {str(k): json_value(val) for k, val in v.items()}
        return str(v)

    items = []
    for doc in tree:
        for item in doc:
            # normalized values exactly as the fingerprint consumes them
            links = []
            for uid in item.links:  # sorted property
                stamp = str(uid.stamp)
                links.append({"uid": str(uid), "fingerprint": stamp or None})
            attributes = {}
            for name in item.extended:  # sorted, non-property _data keys
                attributes[name] = json_value(item._data[name])
            item_dir = os.path.dirname(os.path.relpath(item.path, WS)).replace(os.sep, "/")
            refs = item._data.get("references")
            if refs is not None:
                refs = [
                    {k: (resolve(item_dir, v)
                         if k == "path" else v) for k, v in r.items()}
                    for r in refs
                ]
            issues = []
            for issue in ItemValidator().get_issues(item, skip=[]):
                issues.append({"severity": {
                    "DoorstopInfo": "INFO",
                    "DoorstopWarning": "WARNING",
                    "DoorstopError": "ERROR",
                }.get(issue.__class__.__name__, issue.__class__.__name__),
                               "message": str(issue)})
            with open(item.path, "r", encoding="utf-8") as handle:
                yaml_text = handle.read()
            items.append({
                "uid": str(item.uid),
                "documentPrefix": doc.prefix,
                "path": os.path.relpath(item.path, WS).replace(os.sep, "/"),
                "level": str(item.level),
                "active": item.active,
                "derived": item.derived,
                "normative": item.normative,
                "header": str(item._data.get("header", "")),
                "text": str(item.text),
                "ref": (resolve(item_dir, str(item.ref))
                         if str(item.ref) else ""),
                "references": refs,
                "links": links,
                "attributes": attributes,
                "reviewed": str(item._data["reviewed"].value) if isinstance(
                    item._data["reviewed"].value, str) else None,
                "stamp": str(item.stamp()),            # link-record fingerprint
                "reviewStamp": str(item.stamp(links=True)),  # review fingerprint
                "yaml": yaml_text,
                "issues": issues,
            })

    # items sorted by (level, uid) like the plugin index
    def level_key(level):
        return [int(p) for p in level.split(".")]

    items.sort(key=lambda it: (level_key(it["level"]), it["uid"]))

    # workspace file index (the discovery-walk shape, root-relative; .git is
    # skipped exactly like the plugin's discovery SKIPPED_DIRECTORIES)
    known_file_paths = []
    for dirpath, dirnames, filenames in os.walk(WS):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
        for filename in sorted(filenames):
            rel = os.path.relpath(os.path.join(dirpath, filename), WS)
            known_file_paths.append(rel.replace(os.sep, "/"))
    known_file_paths.sort()

    documents = [
        {
            "directoryPath": "",
            "configPath": ".doorstop.yml",
            "prefix": "REQ",
            "digits": 4,
            "separator": "",
            "parentPrefix": None,
            "itemformat": "yaml",
            "reviewedAttributes": ["type", "verification-method"],
        },
        {
            "directoryPath": "tests",
            "configPath": "tests/.doorstop.yml",
            "prefix": "TST",
            "digits": 4,
            "separator": "",
            "parentPrefix": "REQ",
            "itemformat": "yaml",
            "reviewedAttributes": [],
        },
    ]

    payload = {
        "generator": {
            "tool": "notes/fixture-generator.py",
            "doorstopVersion": getattr(doorstop, "__version__", "?"),
            "doorstopSource": "doorstop-dev/doorstop commit 1f5756390bdeeff58fc22e30d5c5a56bb1a81c16 "
                              "(force-reinstalled into the venv)",
            "createdWith": "doorstop installed in a python3 venv (see header)",
        },
        "documents": documents,
        "items": items,
        "schemaGap": schema_gap_pins(),
        "knownFilePaths": known_file_paths,
    }
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    print("wrote {} ({} items, {} files)".format(OUT, len(items), len(known_file_paths)))
    for it in items:
        print("  {:8s} stamp={:44s} review={} links={}".format(
            it["uid"], it["stamp"], it["reviewStamp"],
            ",".join("{}:{}".format(ln["uid"], ln["fingerprint"] or "-")
                     for ln in it["links"])))


if __name__ == "__main__":
    main()