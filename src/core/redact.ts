import type { IndicatorId } from '../types.ts';

/**
 * Irreversible masking for data that LEAVES the browser (N3): a report
 * pasted into a ticket, a case export sent to a colleague. `report.redact`
 * (settings.ts, default true) is the switch a user can flip to see the
 * clear version instead.
 *
 * ── This is NOT `capture/sanitize.ts` - do not unify the two ──
 * `capture/sanitize.ts` is a format-preserving SUBSTITUTION CIPHER for
 * values on their way into local STORAGE: a fixed, per-page-load table
 * (digit->digit, letter->letter) so `topValues` counts still group and
 * dedupe, and it is honestly documented as resisting a casual glance, not a
 * determined analyst. It never leaves the machine.
 *
 * `redact.ts` masks data that is about to leave the machine, so it must
 * DESTROY information, not permute it. There is no table, no key, no random
 * state at all - every function here is pure and stateless. A digit is not
 * mapped to "another digit of the same shape"; most of the value is thrown
 * away and replaced with a fixed filler, or with a constant placeholder that
 * carries no information about the input whatsoever (see `redactIp` below).
 * Do not give this module a seed, a table, or any form of "reversible if
 * you know the trick" - that would turn a redaction into exactly the
 * mitigation `sanitize.ts` already is, under a different name, for the one
 * case where it must not be one.
 *
 * ── Consistency: deliberately YES, and for the opposite reason sanitize.ts
 *    deliberately regenerates its table every page load ──
 * Given the same value and the same kind, this module always returns the
 * same masked string - no randomness, no session state. That is a real
 * design choice, not an oversight, and it holds for two independent
 * reasons:
 *  1. `report.ts`'s own "Indicateurs rencontrés" section must DEDUPLICATE
 *     pivoted values, and its timeline/KQL appendix repeat the same value
 *     across sections. If masking were randomized per call, two occurrences
 *     of the identical real IP would mask to two different strings and the
 *     masked report would silently lose the very thing it is reporting on
 *     (dedup would break, "pivoted five times" would look like five
 *     different values). Determinism here serves the report's correctness.
 *  2. Unlike `sanitize.ts`'s character substitution (which is a genuine,
 *     if weak, cipher - a frequency-table attack across a session can start
 *     to invert it), these masks are lossy and keyless: a fixed literal
 *     (IP), a few characters of head/tail (hostname), the last 4 hex digits
 *     of a GUID, the last sub-authority of a SID. There is no secret table
 *     to protect by adding randomness, so repeating the same mask for the
 *     same input leaks nothing beyond "this is the same value again" - a
 *     fact the report is already presenting in clear text around it (a
 *     timeline, a dedup list). Randomizing would not make this safer, only
 *     non-reproducible (regenerating the same report twice would silently
 *     produce different masked text).
 *
 * ── Fail-closed policy (hard requirement) ──
 * Every function here returns a string; none throws. When a value does not
 * match the shape its declared `kind` implies, or when no kind can be
 * guessed at all (`redactUnknown`), the result is the OPAQUE placeholder
 * (`***`), never the original value and never a half-measure that happens
 * to reveal more than intended. Over-masking is the only failure mode this
 * module accepts.
 *
 * ── The one deliberate hole: hashes ──
 * A hash is not personal data (N3), so it is returned UNCHANGED - but only
 * when it has a real hash's exact shape: 32/40/64 lowercase-or-uppercase hex
 * characters, nothing else attached. A hex string of any other length (a
 * truncated id, a hex-encoded blob) is NOT exempted and is masked like
 * everything else - the exemption is about matching MD5/SHA1/SHA256 shapes,
 * not "looks hex-ish".
 */

// ── Shared primitives ──

/** Fixed placeholder: carries zero information about the real value. */
const OPAQUE = '***' as const;

/** RFC 5737 TEST-NET-style placeholder - matches the plan's own `203.0.x.x`. */
const DOC_IPV4 = '203.0.x.x' as const;

/** RFC 3849 documentation range - the IPv6 analogue of the choice above. */
const DOC_IPV6 = '2001:db8::x' as const;

function coerce(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

/**
 * Keep only the first character of a fragment (a local part, a SAM name, a bare
 * domain word).
 *
 * Below length 3 the kept character stops being a hint and becomes the value:
 * `a` -> `a***` discloses it entirely, and `x@y` -> `x***@y***` reconstructs
 * both sides. Same argument as `redactDevice`'s guard - a mask that keeps more
 * than it hides is not a mask - so short fragments go fully opaque. Rare in
 * practice (two-character UPN local parts and SAM names barely exist) and
 * cheap when it happens: the report says `***` instead of guessing for the
 * analyst.
 */
function maskFragment(s: string): string {
  if (s.length < 3) return OPAQUE;
  return `${s.charAt(0)}${OPAQUE}`;
}

// ── Shape tests ──

/** Exact MD5 (32) / SHA1 (40) / SHA256 (64) hex length - the narrow exemption. */
const HASH_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `S-<rev>-<authority>-<sub1>...-<RID>`, at least rev+authority+2 subauthorities. */
const SID_RE = /^S-\d+(-\d+){3,}$/i;

/** Whole-string email/UPN shape: `local@domain`, no embedded whitespace. */
const EMAIL_RE = /^([^\s@]+)@([^\s@]+)$/;

/** `DOMAIN\user`, no embedded whitespace on either side. */
const ACCOUNT_RE = /^([^\s\\]+)\\([^\s\\]+)$/;

function isHashShape(v: string): boolean {
  return HASH_RE.test(v);
}

function isIPv4(v: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  return m !== null && m.slice(1, 5).every((octet) => Number(octet) <= 255);
}

/** Heuristic, deliberately permissive - over-matching an IPv6-looking string just masks more. */
function looksLikeIPv6(v: string): boolean {
  if (v.indexOf(':') < 0 || !/^[0-9a-fA-F:.]+$/.test(v)) return false;
  const segments = v.split(':');
  return segments.length >= 3 && segments.length <= 8;
}

// ── Per-kind masks ──

function redactGuid(v: string): string {
  if (!GUID_RE.test(v)) return OPAQUE;
  return `xxxxxxxx-…-${v.slice(-4).toLowerCase()}`;
}

function redactSid(v: string): string {
  if (!SID_RE.test(v)) return OPAQUE;
  const parts = v.split('-');
  const prefix = parts.slice(0, 4).join('-'); // S, revision, authority, first sub-authority
  const last = parts[parts.length - 1];
  return `${prefix}-${OPAQUE}-${last}`;
}

function redactIp(v: string): string {
  if (isIPv4(v)) return DOC_IPV4;
  if (looksLikeIPv6(v)) return DOC_IPV6;
  return OPAQUE; // declared 'ip' but does not look like one - fail closed anyway
}

/** `example.com` -> `e***.com`: real TLD kept, everything before it collapsed. */
function redactDomainValue(v: string): string {
  const dot = v.lastIndexOf('.');
  if (dot <= 0 || dot === v.length - 1) return maskFragment(v);
  const tld = v.slice(dot + 1).toLowerCase();
  const rest = v.slice(0, dot);
  return `${maskFragment(rest)}.${tld}`;
}

function redactEmail(v: string): string {
  const m = EMAIL_RE.exec(v);
  if (!m) return OPAQUE;
  return `${maskFragment(m[1])}@${redactDomainValue(m[2])}`;
}

function redactAccount(v: string): string {
  const m = ACCOUNT_RE.exec(v);
  if (m) return `${maskFragment(m[1])}\\${maskFragment(m[2])}`;
  return maskFragment(v); // bare SAM name, no domain part
}

/**
 * `abcdef01` -> `ab***01`. The head/tail slices are only a hint when they leave
 * most of the value hidden: with 2+2 characters kept, `DC01` (4) came back as
 * `DC***01` - the whole name, which is the common hostname shape - and a
 * 5-character name lost 4 of 5. So the revealed share shrinks with the length:
 *  - below 6 characters: fully opaque;
 *  - 6 and 7: one character at each end (`WKS-042` -> `W***2`);
 *  - 8 and more: two at each end (`abcdef01` -> `ab***01`, the plan's example).
 */
function redactDevice(v: string): string {
  if (v.length < 6) return OPAQUE;
  const keep = v.length < 8 ? 1 : 2;
  return `${v.slice(0, keep)}${OPAQUE}${v.slice(-keep)}`;
}

// ── Public API ──

/**
 * Every masking strategy this module knows. `opaque` is the explicit,
 * no-partial-information fallback for indicator types with no safe
 * partial-mask rule (a process path can embed `C:\Users\<name>\...`; a URL's
 * path/query can embed a token) - used directly, or via `redactIndicatorValue`.
 */
export type RedactKind = 'ip' | 'email' | 'device' | 'account' | 'domain' | 'hash' | 'sid' | 'guid' | 'opaque';

/**
 * Mask one value as a given kind. Never throws, never returns the original
 * value unless `kind === 'hash'` AND the value has a real hash's exact
 * shape. Empty/whitespace-only input is returned unchanged - there is
 * nothing to leak, and masking it would just turn "field intentionally
 * blank" into noise.
 */
export function redactValue(value: unknown, kind: RedactKind): string {
  let v: string;
  try {
    v = coerce(value);
  } catch {
    return OPAQUE;
  }
  if (v.trim() === '') return v;

  try {
    switch (kind) {
      case 'hash':
        return isHashShape(v) ? v : OPAQUE;
      case 'guid':
        return redactGuid(v);
      case 'sid':
        return redactSid(v);
      case 'ip':
        return redactIp(v);
      case 'email':
        return redactEmail(v);
      case 'account':
        return redactAccount(v);
      case 'device':
        return redactDevice(v);
      case 'domain':
        return redactDomainValue(v);
      case 'opaque':
      default:
        return OPAQUE;
    }
  } catch {
    return OPAQUE;
  }
}

/**
 * Guess a kind from shape alone, for text where the caller has no type
 * context (the KQL appendix below). Only shapes with a low false-positive
 * rate are recognized (hash/GUID/SID/IP/email/account all have a fairly
 * rigid grammar); anything else - including a bare hostname, which is
 * indistinguishable from an arbitrary word - falls through to the opaque
 * placeholder rather than risk a wrong, lighter mask. This is intentionally
 * MORE conservative than `redactValue` with an explicit kind.
 */
function detectKind(v: string): RedactKind | undefined {
  if (isHashShape(v)) return 'hash';
  if (GUID_RE.test(v)) return 'guid';
  if (SID_RE.test(v)) return 'sid';
  if (isIPv4(v) || looksLikeIPv6(v)) return 'ip';
  if (EMAIL_RE.test(v)) return 'email';
  if (ACCOUNT_RE.test(v)) return 'account';
  return undefined;
}

/** Mask a value whose kind is not known up front. Fails closed to opaque. */
export function redactUnknown(value: unknown): string {
  let v: string;
  try {
    v = coerce(value);
  } catch {
    return OPAQUE;
  }
  if (v.trim() === '') return v;

  try {
    const kind = detectKind(v);
    return kind ? redactValue(v, kind) : OPAQUE;
  } catch {
    return OPAQUE;
  }
}

/**
 * `IndicatorId` -> `RedactKind`, for `report.ts` (built later): it knows
 * which pivot indicator a value came from and can mask with confidence
 * instead of falling back to shape-guessing. `url`/`process` have no safe
 * partial-mask rule (both can embed a username or a token) and go straight
 * to opaque; `application` ids are usually but not always GUIDs, so it is
 * checked and only trusted with the GUID mask when it actually looks like one.
 */
export function redactIndicatorValue(value: unknown, type: IndicatorId): string {
  if (type === 'application') {
    const v = coerce(value);
    return GUID_RE.test(v) ? redactValue(v, 'guid') : redactValue(v, 'opaque');
  }
  const kind: RedactKind =
    type === 'ip' ||
    type === 'account' ||
    type === 'email' ||
    type === 'domain' ||
    type === 'device' ||
    type === 'hash'
      ? type
      : 'opaque'; // url, process
  return redactValue(value, kind);
}

// ── KQL appendix (N3: "le masquage s'applique aussi au KQL ... valeurs des @"…"") ──

/**
 * A KQL verbatim string literal: `@"..."`, where a literal `"` inside is
 * written as `""` (see `pivot.ts`'s `verbatim()`, which is what put the
 * pivoted value there in the first place). Matches the smallest valid span.
 */
const KQL_LITERAL_RE = /@"((?:""|[^"])*)"/g;

/**
 * Mask every `@"..."` literal's content in a block of KQL. Every literal is
 * masked, not just the ones that happen to hold the pivot value - the plan
 * says "les valeurs des @"…"" without carving out an exception, and a rule
 * whose template has more than one verbatim literal gives no reliable way
 * to tell which one is "the" value from text alone. Shape is guessed per
 * literal (`redactUnknown`): unrecognized content (e.g. a bare hostname)
 * goes fully opaque rather than risk leaving a value readable.
 */
export function redactKqlLiterals(kql: string): string {
  if (typeof kql !== 'string') return '';
  try {
    return kql.replace(KQL_LITERAL_RE, (_whole, inner: string) => {
      const decoded = inner.replace(/""/g, '"');
      const masked = redactUnknown(decoded).replace(/"/g, '""');
      return `@"${masked}"`;
    });
  } catch {
    // Fail closed: if the scan itself breaks, do not hand back text that may
    // still hold a real pivoted value inside a verbatim literal.
    return kql.replace(/@"(?:""|[^"])*"/g, '@"***"');
  }
}

// ── Typed values (report: timeline, indicators) ──

/**
 * Mask a value whose indicator type is known, but let its SHAPE overrule the
 * type. The catalogue's `device` pattern accepts any alphanumeric token, so a
 * GUID or a bare account name can arrive typed `device`; the device mask would
 * then keep head and tail of something that is not a hostname. A shape that
 * `detectKind` recognises (hash/GUID/SID/IP/e-mail/`DOMAIN\user`) therefore
 * takes its own mask; everything else uses the type's mask, and a missing type
 * fails closed to the opaque placeholder.
 */
export function redactTypedValue(value: unknown, type: IndicatorId | undefined): string {
  let v: string;
  try {
    v = coerce(value);
  } catch {
    return OPAQUE;
  }
  if (v.trim() === '') return v;
  try {
    return redactValue(v, kindForTyped(v, type));
  } catch {
    return OPAQUE;
  }
}

/** The mask kind `redactTypedValue` applies: shape first, then the indicator type, else opaque. */
export function kindForTyped(value: string, type: IndicatorId | undefined): RedactKind {
  const shape = detectKind(value);
  if (shape) return shape;
  if (!type) return 'opaque';
  if (type === 'application') return GUID_RE.test(value) ? 'guid' : 'opaque';
  return type === 'ip' || type === 'account' || type === 'email' || type === 'domain' || type === 'device' || type === 'hash'
    ? type
    : 'opaque'; // url, process
}

// ── Free text (report: case note, node notes, comments in KQL) ──

/**
 * A value the caller KNOWS is in the case. A bare string is masked by shape
 * (`redactUnknown`, so anything unrecognised becomes `***`); `{ value, kind }`
 * uses the kind's own mask (`ab***01` for a device).
 */
export type KnownValue = string | { readonly value: string; readonly kind: RedactKind };

/** Pure digits up to this length (an EventID, a port, a PID) say nothing about a person or a machine. */
const MAX_PLAIN_NUMBER = 6;
/** Known values up to this length must stand alone (no alphanumeric neighbour), so `DC01` does not eat `ADC012`. */
const MAX_BOUNDARY_LEN = 4;
const MIN_KNOWN_LEN = 3;

interface TextRule {
  /** lowercased needle */
  readonly needle: string;
  readonly mask: string;
  readonly standalone: boolean;
}

/** Same length as the input in every case: `toLowerCase()` alone can change it (`İ`), which would shift the indices. */
function lowerSameLength(s: string): string {
  let out = '';
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

const ALNUM_RE = /[\p{L}\p{N}]/u;

function isIPv6Strict(token: string): boolean {
  if (token.indexOf(':') < 0) return false;
  let s = token;
  const last = s.lastIndexOf(':');
  const tail = s.slice(last + 1);
  if (tail.indexOf('.') >= 0) {
    if (!isIPv4(tail)) return false;
    s = `${s.slice(0, last + 1)}0:0`; // an embedded IPv4 stands for two groups
  }
  if (s.indexOf(':::') >= 0) return false;
  const dbl = s.indexOf('::');
  if (dbl !== s.lastIndexOf('::')) return false;
  const hex = /^[0-9a-f]{1,4}$/i;
  if (dbl >= 0) {
    const left = dbl === 0 ? [] : s.slice(0, dbl).split(':');
    const right = dbl + 2 >= s.length ? [] : s.slice(dbl + 2).split(':');
    const all = [...left, ...right];
    return all.length >= 1 && all.length <= 7 && all.every((g) => hex.test(g));
  }
  const groups = s.split(':');
  return groups.length === 8 && groups.every((g) => hex.test(g));
}

/** Shape tokens found in free text. `mask` returns null when a candidate fails its strict check (left as is). */
const SHAPE_RULES: readonly { readonly re: RegExp; readonly mask: (tok: string) => string | null }[] = [
  {
    re: /(?<![\p{L}\p{N}])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\p{L}\p{N}])/giu,
    mask: (tok) => redactGuid(tok),
  },
  {
    re: /(?<![\p{L}\p{N}-])S-\d+(?:-\d+){3,}(?![\p{L}\p{N}])/giu,
    mask: (tok) => redactSid(tok),
  },
  {
    re: /(?<![\p{L}\p{N}_.%+'-])[\p{L}\p{N}_.%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?![\p{L}\p{N}])/gu,
    mask: (tok) => redactEmail(tok),
  },
  {
    re: /(?<![\p{L}\p{N}_])[\p{L}\p{N}_][\p{L}\p{N}_.-]*\\[\p{L}\p{N}_$][\p{L}\p{N}_.$-]*/gu,
    mask: (tok) => redactAccount(tok),
  },
  {
    // dotted quad, plain or defanged (`203[.]0[.]113[.]17`)
    re: /(?<!\d)\d{1,3}(?:(?:\[\.\]|\(\.\)|\.)\d{1,3}){3}(?!\d|\.\d)/gu,
    mask: (tok) => {
      const plain = tok.replace(/\[\.\]|\(\.\)/g, '.');
      return isIPv4(plain) ? DOC_IPV4 : null;
    },
  },
  {
    // hex/colon/dot runs, then a strict IPv6 check (so `12:30:45` is left alone)
    re: /(?<![\p{L}\p{N}_:.])[0-9a-f:.]{2,}(?![\p{L}\p{N}_:])/giu,
    mask: (tok) => {
      const core = tok.replace(/\.+$/, '');
      if (!isIPv6Strict(core)) return null;
      return `${DOC_IPV6}${tok.slice(core.length)}`;
    },
  },
];

/**
 * Build a free-text masker (N3 report: notes and KQL comments, which cannot be
 * collapsed to `***` without making the report useless). Two sources of matches,
 * found in one pass over the text and merged:
 *  1. every KNOWN value of the case, case-insensitive, masked with its own mask;
 *  2. every token with a recognisable SHAPE: IPv4 (also defanged), IPv6,
 *     e-mail/UPN, `DOMAIN\user`, SID, GUID.
 * Overlapping matches are merged into one span and take the mask of the longest
 * member, so a value containing another is replaced whole and no fragment of
 * either survives. Hashes are not personal data and are left alone.
 *
 * What it does NOT do - this is weaker than a whole-field collapse, and callers
 * must say so to the reader: anything that is neither a known value nor one of
 * those shapes survives (an unrecognised hostname, a customer or project name, a
 * bare username, a URL without an IP in it, a phone number).
 *
 * Never throws; on any internal failure the whole text becomes `***`.
 */
export function createTextRedactor(known: readonly KnownValue[]): (text: string) => string {
  const rules: TextRule[] = [];
  const seen = new Set<string>();
  try {
    for (const k of known) {
      const typed = typeof k !== 'string';
      const value = coerce(typed ? k.value : k).trim();
      if (value.length < MIN_KNOWN_LEN || value === OPAQUE) continue;
      // Untyped context (row cells): drop what cannot identify anything.
      if (!typed && (/^\d{1,6}$/.test(value) || /^\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?$/.test(value))) continue;
      const mask = typed ? redactValue(value, k.kind) : redactUnknown(value);
      if (mask === value) continue; // a hash: not masked, nothing to replace
      const needle = lowerSameLength(value);
      if (seen.has(needle)) continue;
      seen.add(needle);
      rules.push({ needle, mask, standalone: value.length <= MAX_BOUNDARY_LEN });
    }
  } catch {
    rules.length = 0;
  }
  return (text: string): string => {
    if (typeof text !== 'string' || text === '') return '';
    try {
      const lower = lowerSameLength(text);
      const spans: { start: number; end: number; mask: string }[] = [];
      for (const r of rules) {
        let from = 0;
        for (;;) {
          const at = lower.indexOf(r.needle, from);
          if (at < 0) break;
          from = at + 1;
          const end = at + r.needle.length;
          if (r.standalone) {
            const before = at > 0 ? text.charAt(at - 1) : '';
            const after = end < text.length ? text.charAt(end) : '';
            if ((before && ALNUM_RE.test(before)) || (after && ALNUM_RE.test(after))) continue;
          }
          spans.push({ start: at, end, mask: r.mask });
        }
      }
      for (const rule of SHAPE_RULES) {
        for (const m of text.matchAll(rule.re)) {
          const mask = rule.mask(m[0]);
          if (mask !== null && m.index !== undefined) spans.push({ start: m.index, end: m.index + m[0].length, mask });
        }
      }
      if (spans.length === 0) return text;

      spans.sort((a, b) => a.start - b.start || b.end - a.end);
      let out = '';
      let pos = 0;
      let i = 0;
      while (i < spans.length) {
        const start = spans[i].start;
        let end = spans[i].end;
        let mask = spans[i].mask;
        let longest = end - start;
        i++;
        while (i < spans.length && spans[i].start < end) {
          const len = spans[i].end - spans[i].start;
          if (len > longest) {
            longest = len;
            mask = spans[i].mask;
          }
          if (spans[i].end > end) end = spans[i].end;
          i++;
        }
        out += text.slice(pos, start) + mask;
        pos = end;
      }
      return out + text.slice(pos);
    } catch {
      return OPAQUE;
    }
  };
}

/** One-shot form of `createTextRedactor`. Build the redactor once when masking many texts. */
export function redactText(text: string, known: readonly KnownValue[]): string {
  return createTextRedactor(known)(text);
}

// ── KQL appendix, every string literal ──

/** Does the already-copied output end with a verbatim-string prefix (`@`, `@h`, `@H`)? */
function endsWithVerbatimPrefix(out: string): boolean {
  return /@[hH]?$/.test(out);
}

/**
 * Mask the content of EVERY KQL string literal: `"…"`, `'…'`, `@"…"`, `@'…'`,
 * their obfuscated `h`/`H` forms, and the multi-line ```` ```…``` ```` and
 * `~~~…~~~` forms. `redactKqlLiterals` (above) handles only `@"…"`, the form
 * `core/pivot.ts` emits; an analyst's own `where DeviceName == "DC01"` would
 * stay readable under it, which is why the report does not use it.
 *
 * Each literal's content goes through `redactUnknown` (a recognised shape keeps
 * its shape mask, everything else is `***`); structure, operators, table and
 * column names and numbers are untouched. `//` comments are copied as is (a
 * quote inside a comment is not a literal) - the caller runs a text redactor
 * over the result for those. A literal still open at the end of the text (the
 * stored preview is cut at 300 characters) or, for the single-line forms, at
 * the end of the line, is masked up to that point: fail closed.
 */
export function redactKqlStringLiterals(kql: string, options?: { readonly comments?: 'keep' | 'mask' }): string {
  const maskComments = options?.comments === 'mask';
  if (typeof kql !== 'string') return '';
  try {
    let out = '';
    let i = 0;
    const n = kql.length;
    while (i < n) {
      const ch = kql[i];

      if (ch === '/' && kql[i + 1] === '/') {
        const nl = kql.indexOf('\n', i);
        const end = nl < 0 ? n : nl;
        const comment = kql.slice(i, end);
        if (maskComments) {
          const tag = /^\/\/\s*(\[(?:IP|AC|EM|DM|MC|PR|AP|HS)-[SPT]\d+\])/.exec(comment);
          out += `// ${tag ? `${tag[1]} ` : ''}${OPAQUE}`;
        } else {
          out += comment;
        }
        i = end;
        continue;
      }

      if (kql.startsWith('```', i) || kql.startsWith('~~~', i)) {
        const fence = kql.slice(i, i + 3);
        const close = kql.indexOf(fence, i + 3);
        out += `${fence}${OPAQUE}${close < 0 ? '' : fence}`;
        i = close < 0 ? n : close + 3;
        continue;
      }

      if (ch === '"' || ch === "'") {
        const verbatim = endsWithVerbatimPrefix(out);
        let j = i + 1;
        let closed = false;
        let inner = '';
        while (j < n) {
          const c = kql[j];
          if (verbatim) {
            if (c === ch) {
              if (kql[j + 1] === ch) {
                inner += ch;
                j += 2;
                continue;
              }
              closed = true;
              break;
            }
          } else {
            if (c === '\\' && j + 1 < n) {
              inner += kql[j + 1];
              j += 2;
              continue;
            }
            if (c === ch) {
              closed = true;
              break;
            }
            if (c === '\n') break; // a quoted (non-verbatim) literal cannot span lines
          }
          inner += c;
          j++;
        }
        const masked = redactUnknown(inner);
        const encoded = verbatim
          ? masked.split(ch).join(ch + ch)
          : masked.replace(/\\/g, '\\\\').split(ch).join(`\\${ch}`);
        out += `${ch}${encoded}${closed ? ch : ''}`;
        i = closed ? j + 1 : j;
        continue;
      }

      out += ch;
      i++;
    }
    return out;
  } catch {
    // Fail closed: blank every quoted run rather than hand back text that may still hold a value.
    return kql.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1?/g, (_m, q: string) => `${q}${OPAQUE}${q}`);
  }
}
