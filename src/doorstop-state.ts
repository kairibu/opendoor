// ---------------------------------------------------------------------------
// Opendoor state chain (feature spec §6, risk 1): Doorstop-faithful item
// fingerprints + per-item state chips and findings.
//
// Fidelity contract: `computeItemStamp` must reproduce Doorstop's
// `Item.stamp()` byte-for-byte — SHA-256 over
//   [uid, text, ref, references?, link UIDs (sorted)…, extended reviewed
//    attribute values…]
// serialized exactly as Doorstop's `Stamp.digest` does: each part contributes
// `str(value).encode()` concatenated with no separator, digested, and encoded
// URL-safe Base64 WITH padding (Python `base64.urlsafe_b64encode`).  The parts
// are the Python `str()`/`repr()` forms of the loaded values — the nasty bits:
//
//   - `references` is appended as the WHOLE Python list, so its parts use
//     Python *repr* (single-quoted strings, dict braces, key insertion order
//     `type, path, keyword?, sha?` — Doorstop rebuilds each entry in that
//     order in `Item._set_attributes` before hashing).
//   - `links` is extended element-wise from `sorted(self._data["links"])`
//     (Doorstop stores links as a SET of UID objects), and `sorted` is
//     `UID.__lt__`: case-insensitive prefix, then numeric part, then name.
//     Each element contributes just its UID string (`str(UID)`), never the
//     recorded fingerprint.
//   - extended reviewed attribute values are serialized via Doorstop's
//     `_convert_to_str` (`\L`/`\D` markers, `\T<type>\V<value>` scalars).
//
// YAML-schema caveat (extended reviewed attributes): item YAML is parsed by
// the model chain with js-yaml's YAML 1.2 core-ish schema, NOT PyYAML's
// YAML 1.1 SafeLoader (see the identical caveat in the src/doorstop-model.ts
// header).  `_convert_to_str` embeds the Python TYPE, so scalar typing
// matters — and the JS values the model chain hands over cannot always carry
// it:
//   - `5.0` / `1e2` are PyYAML floats; js-yaml yields the integral JS numbers
//     5 / 100, and a JS number carries NO int-vs-float origin, so the
//     `\T<class 'float'>\V5.0` form Doorstop hashes is unreachable — any
//     extended reviewed attribute holding an integral-float lexeme silently
//     diverges (this is why `5` is int and `5.0` is float only on the Python
//     side; both arrive here as the same JS number).
//   - `yes` is a PyYAML bool (True); js-yaml keeps the string "yes".
//   - `2024-01-01` is a PyYAML datetime.date; js-yaml yields a JS Date.
//     The port renders midnight-UTC Dates as `\T<class 'datetime.date'>\V`
//     + "YYYY-MM-DD" and other Dates as `\T<class 'datetime.datetime'>\V`
//     + Python's utc str() form ("YYYY-MM-DD HH:MM:SS[.ffffff]+00:00") —
//     byte-identical to Python str() for the common cases, but js-yaml
//     normalizes every timestamp to UTC, so any non-UTC offset scalar still
//     diverges (Python keeps the offset).
//   - `.nan` / `.inf` / `-.inf` are PyYAML floats; js-yaml yields NaN /
//     ±Infinity, which the port serializes as Python's "nan"/"inf"/"-inf".
// The `schemaGap` block of src/doorstop-state.fixtures.json pins REAL
// Doorstop's serialization for each of these lexemes with the port's parity
// flagged ("equal" reproduces it byte-for-byte, "divergent" is a documented
// type collapse the port cannot recover); doorstop-state.test.ts asserts both
// sides so the gap stays visible and any serializer change is a review event.
//
// `computeItemStates` mirrors Doorstop's `ItemValidator` for the plugin's chip
// set (§6 table): inactive items get ONLY attribute-mirror chips (Doorstop
// skips them from validation entirely); every other chip comes with the same
// severity Doorstop's validator would emit ("no links to parent document" /
// "suspect link" / "no links from child document" WARNINGs, "linked to
// unknown item" / "external reference not found" ERRORs, "needs initial
// review" INFO vs "unreviewed changes" WARNING, "linked to inactive item"
// INFO vs "linked to non-normative item" WARNING).  The fixture tests pin the
// fingerprints against REAL Doorstop (`notes/fixture-generator.py`,
// src/doorstop-state.fixtures.json) and the severities against Doorstop's own
// captured validation issues.
//
// SHA-256 is hand-rolled (FIPS 180-4, constant-then-`data` schedule) rather
// than WebCrypto because the contract is synchronous: `stampFromFingerprintParts`
// takes and returns plain values and the whole chain runs in the browser where
// Node `crypto` does not exist and `crypto.subtle.digest` is async-only.
// Standard test vectors + the Doorstop fixtures pin its correctness.
// ---------------------------------------------------------------------------

import type {
  ComputeItemStamp,
  ComputeItemStates,
  DoorstopCounts,
  DoorstopDocumentConfig,
  DoorstopIndex,
  DoorstopStampableItem,
  Finding,
  ItemRecord,
  ItemStateKey,
  LinkRecord,
  StampFromFingerprintParts,
} from "./doorstop-contract";
import { isRecord } from "./doorstop-contract";

// --- SHA-256 (FIPS 180-4) ----------------------------------------------------

/** First 32 bits of the fractional parts of the cube roots of the first 64
 *  primes (FIPS 180-4 §4.2.2). */
const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** SHA-256 message schedule (FIPS 180-4 §6.2.2). */
function sha256MessageSchedule(block: Uint8Array, offset: number): number[] {
  const w = new Array<number>(64);
  const view = new DataView(block.buffer, block.byteOffset + offset, 64);
  for (let i = 0; i < 16; i++) {
    w[i] = view.getUint32(i * 4);
  }
  for (let i = 16; i < 64; i++) {
    const w15 = w[i - 15]!;
    const w2 = w[i - 2]!;
    const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
    const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
  }
  return w;
}

/** SHA-256 digest (FIPS 180-4) of `input`, as a 32-byte Uint8Array. */
export function sha256Digest(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  // Padding (FIPS 180-4 §5.1.1): append 0x80, zeros, then the 64-bit length.
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input, 0);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  // The length always fits in 53 bits for in-memory messages (< 1 PiB).
  if (bitLength >= 0x100000000) {
    const high = Math.floor(bitLength / 0x100000000);
    view.setUint32(paddedLength - 8, high);
    view.setUint32(paddedLength - 4, bitLength >>> 0);
  } else {
    view.setUint32(paddedLength - 4, bitLength);
  }
  // Initial hash values (FIPS 180-4 §5.3.3).
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  for (let block = 0; block < paddedLength; block += 64) {
    const w = sha256MessageSchedule(padded, block);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0);
  outView.setUint32(4, h1);
  outView.setUint32(8, h2);
  outView.setUint32(12, h3);
  outView.setUint32(16, h4);
  outView.setUint32(20, h5);
  outView.setUint32(24, h6);
  outView.setUint32(28, h7);
  return out;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with '+'/'-' and '/'/'_', INCLUDING '=' padding — exactly
 *  Python's `base64.urlsafe_b64encode`. */
export function urlsafeB64encode(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i]!;
    const b1 = i + 1 < data.length ? data[i + 1]! : 0;
    const b2 = i + 2 < data.length ? data[i + 2]! : 0;
    out += BASE64_ALPHABET[b0 >> 2]!;
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += i + 1 < data.length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]! : "=";
    out += i + 2 < data.length ? BASE64_ALPHABET[b2 & 0x3f]! : "=";
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

/** Stamp a UTF-8-encoded message. */
function sha256UrlSafeB64(message: Uint8Array): string {
  return urlsafeB64encode(sha256Digest(message));
}

/** UTF-8 encode (browser-safe; replaces lone surrogates like TextEncoder). */
function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// --- Python repr / str port (the exact-Doorstop serialization) --------------

/** Code points Python 3's `repr` escapes as non-printable: every Unicode
 *  category Python's `str.isprintable()` rejects — Other (Cc/Cf/Cs/Co/Cn) or
 *  Separator (Zl/Zp/Zs) — with the single exception of the ASCII space
 *  (U+0020), which IS printable.  Applied to non-ASCII code points only;
 *  ASCII is handled without the regex. */
const PY_NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** One code point → the literal text Python 3 `repr` would emit for it
 *  (control escape, `\x..`/`\u....`/`\U........`), or null when it is
 *  printable and passes through raw. */
function pythonReprEscape(code: number, ch: string): string | null {
  if (ch === "\\") return "\\\\";
  if (ch === "\n") return "\\n";
  if (ch === "\r") return "\\r";
  if (ch === "\t") return "\\t";
  // ASCII controls (C0 + DEL) and the C1 block (0x80-0x9f — U+0085 NEL,
  // U+00A0 NBSP-style spacing are handled by the class below, the C1
  // controls are Cc/Cf and land here first).
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
    return `\\x${code.toString(16).padStart(2, "0")}`;
  }
  // Non-ASCII non-printable: Python `repr` escapes with `\xhh` (< U+0100),
  // `\uhhhh` (< U+10000), `\Uhhhhhhhh` otherwise — all lowercase hex.
  if (code >= 0x80 && PY_NON_PRINTABLE.test(ch)) {
    if (code < 0x100) return `\\x${code.toString(16).padStart(2, "0")}`;
    if (code < 0x10000) return `\\u${code.toString(16).padStart(4, "0")}`;
    return `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return null;
}

/** Python `repr()` of a string for the values Doorstop hashes.  Mirrors the
 *  escaping rules byte-for-byte: single-quoted by default, double-quoted
 *  when the string contains a single quote but no double quote, backslashes
 *  doubled, ASCII controls as `\n`/`\r`/`\t`/`\xXX`, and every non-ASCII
 *  NON-PRINTABLE code point escaped exactly like Python 3 repr (`\x85`,
 *  `\xa0` NBSP, `\u2028` line separator, `\ufeff` BOM, …).  Printable
 *  non-ASCII — including supplementary-plane emoji — passes through raw. */
export function pyStringRepr(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    const escaped = pythonReprEscape(code, ch);
    out += escaped ?? ch;
  }
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  if (quote === '"') {
    return `"${out.replace(/"/g, '\\"')}"`;
  }
  return `'${out.replace(/'/g, "\\'")}'`;
}

/** Python string form of a scalar for `_convert_to_str` / `Stamp.digest`.
 *  A JS number that is an integer serializes as an int, a fractional one as
 *  a float — but a JS `number` carries NO int-vs-float origin, and js-yaml's
 *  YAML 1.2 core-ish schema collapses the lexemes `5` (PyYAML int) and `5.0`
 *  (PyYAML float) onto the same value.  The model chain CANNOT preserve that
 *  distinction, so an extended reviewed attribute written as `5.0`/`1e2`
 *  silently serializes as `<class 'int'>`/`5`/`100` instead of Doorstop's
 *  `<class 'float'>`/`5.0`/`100.0` — pinned as a documented divergence in
 *  the schema-gap fixtures.  Non-finite numbers use Python's `str()`
 *  spellings (`nan`/`inf`/`-inf`; js-yaml maps `.nan`/`.inf`/`-.inf` onto
 *  JS NaN/±Infinity).  Python `str(float)` formatting differences for exotic
 *  magnitudes (`1e-07` vs `1e-7`, `1e+16` vs `10000000000000000`) remain a
 *  documented limitation. */
function pyScalarString(value: string | number | bigint | boolean | null): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null) return "None";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return String(value);
  }
  return value;
}

/** Python `type(value)` name for `_convert_to_str`'s `\T<name>\V<value>`.
 *  NaN/±Infinity are Python floats, so they get `<class 'float'>` (the
 *  integral-float vs int collapse described on `pyScalarString` applies). */
function pyTypeName(value: string | number | bigint | boolean | null): string {
  if (typeof value === "string") return "<class 'str'>";
  if (typeof value === "boolean") return "<class 'bool'>";
  if (value === null) return "<class 'NoneType'>";
  if (typeof value === "bigint") return "<class 'int'>";
  return Number.isInteger(value) ? "<class 'int'>" : "<class 'float'>";
}

/** Python `str(value)` for a list/dict container: str(list) == repr(list),
 *  so elements use their repr (strings single-quoted, nested containers
 *  recursive).  Keys of a dict serialize in their insertion order —
 *  `Item._set_attributes` rebuilds reference entries as
 *  {type, path, keyword?, sha?} before hashing. */
function pyContainerString(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => pyReprInner(v)).join(", ")}]`;
  }
  // js-yaml parses YAML timestamps as JS Dates; the str() form is rendered
  // like Python's (unreachable via the validated `references` entries, kept
  // for uniformity).
  if (value instanceof Date) return pyDateString(value);
  if (isRecord(value)) {
    const body = Object.keys(value)
      .map((key) => `${pyReprInner(key)}: ${pyReprInner(value[key])}`)
      .join(", ");
    return `{${body}}`;
  }
  return pyStringRepr(value as string);
}

function pyReprInner(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") {
    return pyScalarString(value);
  }
  if (typeof value === "string") return pyStringRepr(value);
  if (value instanceof Date) return pyDateString(value);
  if (Array.isArray(value) || isRecord(value)) return pyContainerString(value);
  return pyStringRepr(String(value));
}

/** `str(value)` for a plain Python object — the form `Stamp.digest` hashes
 *  for the references part. */
function pyStr(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") {
    return pyScalarString(value);
  }
  if (typeof value === "string") return value;
  return pyContainerString(value);
}

/** Python `str()` form of a JS Date for `_convert_to_str` / container
 *  serialization.  js-yaml parses YAML timestamps (PyYAML's datetime.date /
 *  datetime.datetime) as JS Dates and normalizes every one of them to UTC,
 *  so the original scalar's kind and offset are partially unrecoverable.
 *
 *  The render matches Python `str()` byte-for-byte for the common cases:
 *  midnight-UTC Dates are `date`s ("YYYY-MM-DD"), everything else is a UTC
 *  `datetime` ("YYYY-MM-DD HH:MM:SS[.ffffff]+00:00", microseconds from
 *  milliseconds).  Non-UTC offset scalars and fractional seconds beyond
 *  milliseconds diverge (js-yaml already discarded that information); both
 *  are documented in the module header and pinned in the schema-gap fixtures. */
function pyDateString(date: Date): string {
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  const y = date.getUTCFullYear();
  const mo = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const h = date.getUTCHours();
  const mi = date.getUTCMinutes();
  const s = date.getUTCSeconds();
  const ms = date.getUTCMilliseconds();
  const datePart = `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}`;
  if (h === 0 && mi === 0 && s === 0 && ms === 0) {
    return datePart;
  }
  const timePart = `${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}`;
  const micro = ms > 0 ? `.${pad(ms * 1000, 6)}` : "";
  return `${datePart} ${timePart}${micro}+00:00`;
}

/** Python `type(value)` name for a JS Date: `datetime.date` for the
 *  midnight-UTC (date-only lexeme) form, `datetime.datetime` otherwise. */
function pyDateTypeName(date: Date): string {
  return pyDateString(date).length === 10 ? "<class 'datetime.date'>" : "<class 'datetime.datetime'>";
}

/** Port of Doorstop's `_convert_to_str(value, "")`: `\L` before each list,
 *  `\D` before each dict (keys sorted, only values serialized), and
 *  `\T<class 'X'>\Vvalue` scalars with backslashes doubled. */
export function doorstopConvertToStr(value: unknown): string {
  let out = "";
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      out += "\\L";
      for (const element of v) visit(element);
      return;
    }
    // js-yaml timestamps (PyYAML dates) arrive as JS Dates — serialize them
    // with the Python date/datetime str() forms instead of falling into the
    // record branch (which would render a misleading `\D`).
    if (v instanceof Date) {
      out += "\\T" + pyDateTypeName(v) + "\\V" + pyDateString(v).replace(/\\/g, "\\\\");
      return;
    }
    if (isRecord(v)) {
      out += "\\D";
      for (const key of Object.keys(v).sort()) visit(v[key]);
      return;
    }
    const scalar = v as string | number | bigint | boolean | null;
    out += "\\T" + pyTypeName(scalar) + "\\V" + String(pyScalarString(scalar)).replace(/\\/g, "\\\\");
  };
  visit(value);
  return out;
}

// --- UID parsing + link sorting (Doorstop `UID.__lt__`) -----------------------

/**
 * Split a UID string into its Doorstop parts (port of `UID.split_uid`,
 * doorstop/core/types.py `split_uid`): [prefix, number, name] where named
 * UIDs get -1 and a name, unparseable values null (Doorstop's `check()`
 * raises; comparisons fall back to the raw string).  SEP_CHARS = "-_." is
 * Doorstop's `settings.SEP_CHARS`.
 *
 * Two faithfulness details pinned against the real implementation:
 *  - Python `re.match` is a PREFIX match, so trailing junk is ignored:
 *    "REQ001foo" parses as (REQ, 1) here exactly like Python (both regexes
 *    are deliberately end-UNANCHORED).
 *  - the numeric part uses Python `int()` semantics — base-10 ONLY — so
 *    "REQ-0x10" / "REQ-1e2" are NAMES (number -1), never hex/exponent
 *    numbers; every candidate is guarded with a strict `/^\d+$/` decimal
 *    check instead of `Number()` coercion (which would read them as 16 / 100).
 *
 * One documented approximation: Python `\w`/`\d` are Unicode-aware while
 * these JS regexes are ASCII-only — a UID with non-ASCII word characters
 * (e.g. "REQ١٢٣") parses in Python but falls back to the raw-string
 * comparison here.  Doorstop-generated UIDs are ASCII, and the sort tie-break
 * compares every unparseable UID by raw string, so such workspaces stay
 * consistent.  Numeric parts larger than Number.MAX_SAFE_INTEGER lose
 * precision the way Python big ints would not (unrealistic for `digits`-
 * bounded Doorstop UIDs).
 */
export function splitDoorstopUid(value: string): { prefix: string | null; number: number; name: string } | null {
  // Doorstop's first regex: `([\w.-]+)[\-_.](\w+)` — a separator splits a
  // prefix from a trailing word; that word is a NUMBER when Python int()
  // accepts it (strict base-10 digits) and a NAME otherwise.
  const first = /^([\w.-]+)[\-_.](\w+)/.exec(value);
  if (first) {
    const rest = first[2]!;
    if (/^\d+$/.test(rest)) {
      return { prefix: first[1]!, number: Number(rest), name: "" };
    }
    return { prefix: first[1]!, number: -1, name: rest };
  }
  // Second regex `([\w.-]*\D)(\d+)` — greedy backtracking lands the LAST
  // non-digit in group 1, exactly like Python's re module; unanchored end
  // matches Python re.match, so trailing non-digit junk is ignored
  // ("REQ001foo" → (REQ, 1)).
  const second = /^([A-Za-z0-9_.\-]*\D)(\d+)/.exec(value);
  if (second) {
    const prefix = (second[1] as string).replace(/[\-_.]+$/, "");
    return { prefix, number: Number(second[2]), name: "" };
  }
  return null;
}

export interface DoorstopUidParts {
  prefix: string | null;
  number: number;
  name: string;
}

/** Doorstop `UID.__lt__`: equal case-insensitive prefixes compare the numeric
 *  part (then name), otherwise the lowercased prefix.  Unparseable UIDs fall
 *  back to raw string comparison. */
export function compareDoorstopUids(a: string, b: string): number {
  const ap = splitDoorstopUid(a);
  const bp = splitDoorstopUid(b);
  if (!ap || !bp) return a < b ? -1 : a > b ? 1 : 0;
  const aPrefix = ap.prefix!.toLowerCase();
  const bPrefix = bp.prefix!.toLowerCase();
  if (aPrefix === bPrefix) {
    if (ap.number === bp.number) {
      return ap.name < bp.name ? -1 : ap.name > bp.name ? 1 : 0;
    }
    return ap.number < bp.number ? -1 : ap.number > bp.number ? 1 : 0;
  }
  return aPrefix < bPrefix ? -1 : aPrefix > bPrefix ? 1 : 0;
}

/** Sort link records the way Doorstop sorts its UID set for stamping/
 *  printing: by `UID.__lt__`, ties kept stable (input order). */
export function sortLinkRecords(links: readonly LinkRecord[]): LinkRecord[] {
  return [...links].sort((a, b) => compareDoorstopUids(a.uid, b.uid));
}

// --- extended reviewed attribute names ----------------------------------------

/**
 * Sorted, deduplicated names of the document's extended reviewed attributes
 * (`attributes.reviewed` in `.doorstop.yml`, preserved in
 * `DoorstopDocumentConfig.extra`).  Doorstop: `sorted(set(...))` — this
 * function re-derives it so the model chain never needs to pre-sort.
 * Reads `extra.attributes.reviewed` (canonical file shape) or a flattened
 * `extra.reviewed` fallback; non-string entries are ignored.
 *
 * One deliberate divergence: Doorstop's `Document` (document.py, the
 * `attributes.reviewed` branch) iterates ANY value — a string `reviewed:
 * type` yields its CHARACTERS upstream (`['e','p','t','y']`, which then
 * never match a real extended attribute).  The port instead treats a
 * non-array value as "no reviewed attributes" (returning []) — a malformed
 * config becomes a no-op rather than a silent char-splitting bug.  The
 * practical fingerprints coincide either way, and there is no diagnostic
 * channel on this path; the divergence is documented here for the reviewer.
 */
export function reviewedAttributeNames(config: DoorstopDocumentConfig): string[] {
  const extra = config.extra ?? {};
  const attributesSection = isRecord(extra["attributes"]) ? extra["attributes"] : {};
  const raw: unknown = attributesSection["reviewed"] ?? extra["reviewed"];
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && !names.includes(entry)) names.push(entry);
  }
  return names.sort();
}

// --- the contract functions ----------------------------------------------------

/**
 * `stampFromFingerprintParts` — Doorstop `Stamp.digest` equivalent: SHA-256
 * over the concatenated parts, URL-safe Base64 (with padding).  The parts are
 * pre-serialized exactly as Doorstop hashes them (`str()` of each value).
 */
export const stampFromFingerprintParts: StampFromFingerprintParts = (
  parts: string[],
): string => sha256UrlSafeB64(utf8Encode(parts.join("")));

/**
 * `computeItemStamp` — Doorstop `Item.stamp(links)` port.
 *
 * includeLinks defaults to true (the `reviewed` stamp, `doorstop review`);
 * false reproduces the link-record stamp used in suspect-link comparisons.
 * Both variants share this implementation.  Extended reviewed attribute names
 * come from the document config (sorted+deduped), values from
 * `item.attributes`; configured-but-absent attributes contribute nothing
 * (Doorstop: `if key in self._data`).
 */
export const computeItemStamp: ComputeItemStamp = (
  item: DoorstopStampableItem,
  config: DoorstopDocumentConfig,
  includeLinks: boolean = true,
): string => {
  const parts: string[] = [item.uid, item.text, item.ref];

  // Doorstop: `if self.references:` — appended as the WHOLE Python list, so
  // the parts are the repr of each nested dict; an empty list contributes
  // nothing (falsy).
  if (item.references !== undefined && item.references.length > 0) {
    parts.push(pyStr(item.references));
  }

  if (includeLinks) {
    for (const link of sortLinkRecords(item.links)) {
      // `values.extend(self.links)` — each UID contributes str(uid) only,
      // never its recorded fingerprint.
      parts.push(link.uid);
    }
  }

  for (const name of reviewedAttributeNames(config)) {
    const value = item.attributes[name];
    if (value !== undefined) {
      parts.push(doorstopConvertToStr(value));
    }
  }

  return stampFromFingerprintParts(parts);
};

// --- state chips and findings ---------------------------------------------------

const STATE_KEY_ORDER: ItemStateKey[] = [
  "normative",
  "non-normative",
  "inactive",
  "reviewed",
  "unreviewed",
  "suspect-link",
  "no-child-links",
  "no-links",
  "unknown-link",
  "missing-reference",
];

function mkFinding(severity: Finding["severity"], fields: { uid?: string; path?: string; message: string }): Finding {
  return {
    severity,
    ...(fields.uid !== undefined ? { uid: fields.uid } : {}),
    ...(fields.path !== undefined ? { path: fields.path } : {}),
    ...{ message: fields.message },
  };
}

/** Config for an item's own document (or an inert fallback so the index can
 *  survive a missing config without losing stamps). */
function configForItem(index: DoorstopIndex, item: ItemRecord): DoorstopDocumentConfig {
  const config = index.byPrefix.get(item.documentPrefix);
  if (config) return config;
  return {
    directoryPath: "",
    configPath: "",
    prefix: item.documentPrefix,
    digits: 0,
    separator: "",
    itemformat: "yaml",
    extra: {},
  };
}

interface ItemStateContext {
  findings: Finding[];
}

/** Compute all chips + findings for one item.  Mutates the shared ItemRecord
 *  (the very object referenced from byUid/childrenByUid) and the accumulated
 *  counts/findings. */
function annotateItem(index: DoorstopIndex, item: ItemRecord, context: ItemStateContext): void {
  item.stateKeys.length = 0;
  const pushKey = (key: ItemStateKey): void => {
    item.stateKeys.push(key);
  };

  // Attribute mirrors — unconditional (Doorstop skips nothing here).
  pushKey(item.normative ? "normative" : "non-normative");

  // Doorstop: inactive items are excluded from validation entirely, so only
  // the mirror chips (and no findings) apply to them.
  if (!item.active) {
    pushKey("inactive");
    return;
  }

  const config = configForItem(index, item);

  // Doorstop validator order: document-level links, tree-level links,
  // reverse (child) links, review status, then the plugin's own reference
  // check against the discovery file index.

  // non-normative items must not link out
  if (!item.normative && item.links.length > 0) {
    context.findings.push(
      mkFinding("warning", { uid: item.uid, message: "non-normative, but has links" }),
    );
  }

  // no links to the parent document (Doorstop: ItemValidator
  // _get_issues_document)
  const parentPrefix = index.byPrefix.get(item.documentPrefix)?.parentPrefix;
  if (parentPrefix !== undefined && parentPrefix !== "" && item.normative && !item.derived && item.links.length === 0) {
    pushKey("no-links");
    context.findings.push(
      mkFinding("warning", { uid: item.uid, message: `no links to parent document: ${parentPrefix}` }),
    );
  }

  // link-by-link checks against the tree (Doorstop: _get_issues_tree)
  for (const link of item.links) {
    const target = index.byUid.get(link.uid);
    if (!target) {
      pushKey("unknown-link");
      context.findings.push(
        mkFinding("error", { uid: item.uid, message: `linked to unknown item: ${link.uid}` }),
      );
      continue;
    }
    if (!target.active) {
      context.findings.push(
        mkFinding("info", { uid: item.uid, message: `linked to inactive item: ${link.uid}` }),
      );
    }
    if (!target.normative) {
      context.findings.push(
        mkFinding("warning", { uid: item.uid, message: `linked to non-normative item: ${link.uid}` }),
      );
    }
    // suspect-link: recorded fingerprint != the parent's CURRENT link-record
    // stamp.  null recordings are never suspect (Doorstop stamps new links
    // itself — STAMP_NEW_LINKS).
    if (link.fingerprint !== null) {
      const parentStamp = computeItemStamp(target, configForItem(index, target), false);
      if (link.fingerprint !== parentStamp) {
        pushKey("suspect-link");
        context.findings.push(
          mkFinding("warning", { uid: item.uid, message: `suspect link: ${link.uid}` }),
        );
      }
    }
  }

  // reverse (child) links: chip when the document has child documents but no
  // item of a child document links to this one (Doorstop: _get_issues_both,
  // CHECK_CHILD_LINKS + item.normative)
  const childPrefixes: string[] = [];
  for (const document of index.documents) {
    if (document.parentPrefix === item.documentPrefix) childPrefixes.push(document.prefix);
  }
  if (item.normative && childPrefixes.length > 0) {
    const childPrefixSet = new Set(childPrefixes);
    const childLinks = (index.childrenByUid.get(item.uid) ?? []).filter((child) =>
      childPrefixSet.has(child.documentPrefix),
    );
    if (childLinks.length === 0) {
      pushKey("no-child-links");
      for (const childPrefix of childPrefixes) {
        context.findings.push(
          mkFinding("warning", { uid: item.uid, message: `no links from child document: ${childPrefix}` }),
        );
      }
    }
  }

  // review status (Doorstop: CHECK_REVIEW_STATUS)
  const reviewStamp = computeItemStamp(item, config, true);
  const storedReview: string | null = item.reviewed === undefined ? null : item.reviewed;
  if (storedReview !== null && storedReview === reviewStamp) {
    pushKey("reviewed");
  } else {
    pushKey("unreviewed");
    context.findings.push(
      mkFinding(
        storedReview === null ? "info" : "warning",
        { uid: item.uid, message: storedReview === null ? "needs initial review" : "unreviewed changes" },
      ),
    );
  }

  // missing references against the discovery file index (plugin-local; the
  // contract labels it best effort — `doorstop validate` stays authoritative)
  const referencePaths: string[] = [];
  if (item.ref !== "") referencePaths.push(item.ref);
  if (item.references !== undefined) {
    for (const reference of item.references) referencePaths.push(reference.path);
  }
  for (const path of referencePaths) {
    if (!index.knownFilePaths.has(path)) {
      pushKey("missing-reference");
      context.findings.push(
        mkFinding("error", { uid: item.uid, message: `external reference not found: ${path}` }),
      );
    }
  }
}

/** Key for findings deduplication: identical (severity, uid, message).
 *  The `path` of a Finding is deliberately NOT part of the identity: state
 *  findings never carry a path while their model-chain counterparts (e.g.
 *  "linked to unknown item") usually do — including `path` would fail to
 *  collapse the two copies of the same condition.  Two model-chain findings
 *  differing only by `path` are not a real shape here (one Finding per
 *  condition), so the omitted field costs nothing.
 *  The model chain already emits e.g. "linked to unknown item" at index
 *  time; computeItemStates must not duplicate it while still owning the
 *  per-item state findings. */
function findingsKey(finding: Finding): string {
  return JSON.stringify([
    finding.severity,
    finding.uid ?? null,
    finding.message,
  ]);
}

/** Keys of the findings the most recent `computeItemStates` run APPENDED to
 *  each index (weakly held, so the map never leaks a dead index and never
 *  mutates the frozen-contract `DoorstopIndex` shape).  They identify the
 *  state-owned portion of `index.findings` exactly — by key, not by message
 *  pattern — so a re-run can drop it before re-deriving (see below). */
const stateOwnedFindings = new WeakMap<DoorstopIndex, ReadonlySet<string>>();

/**
 * `computeItemStates` — annotate every item with state chips, append the
 * per-item state findings, and fill the four state-driven counters.
 * Idempotent ACROSS INDEX CHANGES: re-running recomputes stateKeys and
 * counters from the current index, drops the findings the PREVIOUS run
 * appended (tracked per index object above), and re-derives the current
 * ones — a stale finding (e.g. a "suspect link" for a link cleared since
 * the last run, or an "unreviewed changes" notice for an item re-reviewed
 * in between) cannot survive a re-run over the same index.
 * Existing model-chain index-time structural findings are preserved
 * untouched (their keys were never state-appended, so the drop filter skips
 * them); fresh state findings that duplicate a model-chain finding verbatim
 * are not re-emitted (the model-chain copy is order-first and wins).
 * `ok` is kept consistent with diagnostics + findings.
 */
export const computeItemStates: ComputeItemStates = (index: DoorstopIndex): void => {
  const context: ItemStateContext = {
    findings: [],
  };

  for (const item of index.items) {
    annotateItem(index, item, context);
    // record per-item chip flags in stable STATE_KEY_ORDER so tests and UI
    // render deterministic chip order regardless of annotation order
    const ordered: ItemStateKey[] = [];
    for (const key of STATE_KEY_ORDER) {
      if (item.stateKeys.includes(key)) ordered.push(key);
    }
    item.stateKeys.length = 0;
    item.stateKeys.push(...ordered);
  }

  // Drop the state-owned portion the last run appended (stale after any
  // index change), then append the freshly computed findings.  Keep-first
  // dedupe over (severity, uid, message) with a Set — O(n), and a model-chain
  // duplicate earlier in the merged list suppresses a verbatim state copy.
  let structural: Finding[] = index.findings;
  const priorOwned = stateOwnedFindings.get(index);
  if (priorOwned !== undefined && priorOwned.size > 0) {
    structural = index.findings.filter((finding) => !priorOwned.has(findingsKey(finding)));
  }
  const merged: Finding[] = [];
  const seen = new Set<string>();
  const addedOwned = new Set<string>();
  const contextSet = new Set(context.findings);
  for (const finding of [...structural, ...context.findings]) {
    const key = findingsKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(finding);
    if (contextSet.has(finding)) addedOwned.add(key);
  }
  index.findings = merged;
  stateOwnedFindings.set(index, addedOwned);

  const counts: DoorstopCounts = index.counts;
  counts.suspectLinks = index.items.filter((item) => item.stateKeys.includes("suspect-link")).length;
  counts.unreviewedChanges = index.items.filter((item) => item.stateKeys.includes("unreviewed")).length;
  counts.unknownLinks = index.items.filter((item) => item.stateKeys.includes("unknown-link")).length;
  counts.missingReferences = index.items.filter((item) => item.stateKeys.includes("missing-reference")).length;

  index.ok =
    !index.diagnostics.some((diagnostic) => diagnostic.severity === "error") &&
    !index.findings.some((finding) => finding.severity === "error");
};