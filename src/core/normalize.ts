import type { IndicatorId } from '../types.ts';
import { log } from './log.ts';

/**
 * Value cleanup before detection and before filling a query [#15].
 *
 * Split into two stages, because detection itself needs a stage-1-normalized
 * value to even recognize the type (a defanged `hxxp://evil[.]com` will not
 * match a URL regex), but some cleanup (port stripping, hash casing, domain
 * casing) only makes sense once the type is known. One type-aware function
 * as the plan's checklist literally writes it (`normalizeValue(value, type)`)
 * would be a chicken-and-egg: you cannot pass a type you have not detected
 * yet, and you cannot detect it from the raw, still-defanged text.
 *
 * - `preNormalize(value)` — type-agnostic, SAFE to run before detection:
 *   trim, strip wrapping quotes, refang, strip invisible characters. Call
 *   this first, run detection on its result, then call `normalize` below
 *   with the detected type.
 * - `normalize(value, type)` — type-aware, run once the type is chosen
 *   (detection, or the user's manual indicator pick in the panel). Internally
 *   it also runs `preNormalize` first, so callers that already know the type
 *   can call this alone and still get refang/trim/quotes for free.
 *
 * Pure: no DOM, no storage, no network. Never throws — this runs on whatever
 * the analyst right-clicked, and a value this module cannot make sense of
 * should come back unchanged rather than blow up the caller.
 */

// ── Stage 1: type-agnostic pre-normalization ──

/**
 * Zero-width space/joiner/BOM characters that sometimes ride along a
 * copy-paste. Written as \u escapes (not literal characters) so the
 * invisible characters stay visible and greppable in the source and in diffs.
 */
const INVISIBLE_RE = /[\u200b-\u200d\ufeff]/g;

/** NBSP and other unicode spaces, folded to a normal space before trim. */
const UNICODE_SPACE_RE = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

/** `"value"`, `'value'` or `` `value` `` — a single matching pair, not nested. */
const WRAPPING_QUOTES_RE = /^(["'`])([\s\S]*)\1$/;

/**
 * `[.]`, `(.)`, `{.}` → `.`, but only between two label-ish characters
 * (letter, digit, or another dot already produced by this same rule). This
 * keeps a real bracketed filename like `report[1].pdf` or a KQL/array literal
 * untouched: there is no label character right before the `1`, so it does not
 * match. Applied repeatedly so multi-dot defanging (`a[.]b[.]c`) fully resolves.
 */
const REFANG_DOT_RE = /([A-Za-z0-9])[([{]\.[)\]}]/g;

/** `[:]` between two label-ish characters (e.g. `1[:]2` inside an IPv6/port). */
const REFANG_COLON_RE = /([A-Za-z0-9])\[:\]/g;

/** `[@]` or `(at)` → `@`, the common e-mail defang forms. */
const REFANG_AT_RE = /\[@\]|\(at\)/gi;

/** `hxxp`/`hxxps` (any case) at the start of a scheme → `http`/`https`. */
const REFANG_SCHEME_RE = /\bhxxps?\b/gi;

function refangScheme(s: string): string {
  return s.replace(REFANG_SCHEME_RE, (m) => (m.toLowerCase() === 'hxxps' ? 'https' : 'http'));
}

/**
 * Type-agnostic cleanup, safe to run BEFORE detection: trimming, quote
 * stripping and refanging do not depend on knowing whether the value is an
 * IP, a hash or a URL — they just undo common analyst/report formatting so
 * the detection regexes (and the type-aware stage below) see a clean string.
 */
export function preNormalize(value: string): string {
  if (typeof value !== 'string') return '';

  try {
    let v = value.replace(INVISIBLE_RE, '').replace(UNICODE_SPACE_RE, ' ').trim();
    if (v === '') return '';

    const quoted = WRAPPING_QUOTES_RE.exec(v);
    if (quoted) v = quoted[2].trim();

    v = refangScheme(v);
    v = v.replace(REFANG_AT_RE, '@');
    // Repeat so `a[.]b[.]c` resolves fully (each pass only looks one dot ahead).
    let prev: string;
    do {
      prev = v;
      v = v.replace(REFANG_DOT_RE, '$1.');
      v = v.replace(REFANG_COLON_RE, '$1:');
    } while (v !== prev);

    return v;
  } catch (err) {
    log.error('preNormalize failed, returning raw value', err);
    return value;
  }
}

// ── Stage 2: type-aware normalization ──

/** Plausible IPv4: four 0-255 groups. Used to gate port stripping. */
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** `::ffff:a.b.c.d` — IPv4-mapped IPv6 prefix. */
const IPV4_MAPPED_RE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** `[addr]:port` — brackets make "this is a port, strip it" unambiguous. */
const BRACKETED_HOST_PORT_RE = /^\[(.+)]:\d+$/;

/** Bare `ipv4:port` only — never strip trailing `:digits` off a bare IPv6. */
const IPV4_PORT_RE = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/;

/**
 * Strip a trailing port, but ONLY when unambiguous:
 * - `[addr]:port` → `addr` (brackets are the IPv6-with-port notation)
 * - `ipv4:port` → `ipv4` (checked against the IPv4 regex, not just "has a colon")
 * A bare `2001:db8::1` has many colons and no port — must come back untouched.
 */
function stripPort(value: string): string {
  const bracketed = BRACKETED_HOST_PORT_RE.exec(value);
  if (bracketed) return bracketed[1];

  const ipv4Port = IPV4_PORT_RE.exec(value);
  if (ipv4Port && IPV4_RE.test(ipv4Port[1])) return ipv4Port[1];

  return value;
}

/** `::ffff:192.0.2.1` → `192.0.2.1`. Leaves plain IPv6 and plain IPv4 untouched. */
function stripIPv4Mapped(value: string): string {
  const m = IPV4_MAPPED_RE.exec(value);
  return m ? m[1] : value;
}

function normalizeIp(value: string): string {
  return stripIPv4Mapped(stripPort(value));
}

/** Lower-case only the domain part, keeping the local part's case as typed. */
function normalizeEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at < 0) return value;
  return value.slice(0, at + 1) + value.slice(at + 1).toLowerCase();
}

/**
 * Type-aware normalization, applied once a type is known (from detection or
 * from the user's manual pick in the panel). Runs `preNormalize` first so a
 * caller that already knows the type can call this alone.
 */
export function normalize(value: string, type: IndicatorId): string {
  const pre = preNormalize(value);
  if (pre === '') return '';

  try {
    let out = pre;
    switch (type) {
      case 'ip':
        out = normalizeIp(pre);
        break;
      case 'hash':
        out = pre.toLowerCase();
        break;
      case 'email':
        out = normalizeEmail(pre);
        break;
      case 'domain':
        // The whole value IS the domain here (unlike email, no local part to preserve).
        out = pre.toLowerCase();
        break;
      default:
        out = pre;
    }

    if (out !== value) {
      log.debug('normalize changed value', { type, before: value, after: out });
    }
    return out;
  } catch (err) {
    log.error('normalize failed, returning pre-normalized value', { type }, err);
    return pre;
  }
}
