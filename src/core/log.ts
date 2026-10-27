import { getSetting } from './settings.ts';

/**
 * Console logging for EasyPivot. Deliberately verbose: the script runs inside
 * someone else's SPA, where most failures are "the portal moved a selector"
 * rather than an exception, and the console is the only way to see that.
 *
 * Messages are DEVELOPER-facing, so they stay in English and do NOT go through
 * `t()`. Routing them through i18n would double every dictionary entry for no
 * user benefit — the panel is what gets translated, not the console.
 *
 * ── What must never be logged ──
 * An `Authorization` header, a Bearer token, a cookie, an `X-XSRF-TOKEN`, or
 * any other credential. Project rule 3 is absolute and applies here too: the
 * capture layer (phase 4) will see those values, and a stray `log.debug(headers)`
 * would put them in a console the user may well screenshot into a ticket.
 *
 * IOC values, column names and table names ARE allowed: the console never
 * leaves the browser, and seeing the value is the whole point when debugging a
 * detection. That is the line — credentials never, data locally yes. Note the
 * contrast with `core/health.ts`, whose diagnostics text IS meant to be copied
 * out and therefore carries no values at all.
 *
 * Do NOT import this from `core/storage.ts`: this module reads a setting, which
 * reads storage, so logging inside storage would close an import cycle.
 */

const PREFIX = '[EasyPivot]';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

const RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100,
};

/** Resolved once per call so changing the setting takes effect without reload. */
function enabled(level: Exclude<LogLevel, 'off'>): boolean {
  const configured = (getSetting('logLevel') ?? 'debug') as LogLevel;
  return RANK[level] >= RANK[configured];
}

/** Never let logging itself break the page (console can be stubbed or frozen). */
function emit(level: Exclude<LogLevel, 'off'>, args: readonly unknown[]): void {
  try {
    if (!enabled(level)) return;
    const fn = level === 'debug' ? console.debug : level === 'info' ? console.info
      : level === 'warn' ? console.warn : console.error;
    fn.call(console, PREFIX, ...args);
  } catch {
    // A logger that throws is worse than no logger.
  }
}

export const log = {
  debug: (...args: unknown[]): void => emit('debug', args),
  info: (...args: unknown[]): void => emit('info', args),
  warn: (...args: unknown[]): void => emit('warn', args),
  error: (...args: unknown[]): void => emit('error', args),

  /**
   * Time a step and log its duration. Returns the callback's value, so it can
   * wrap an existing expression without restructuring the caller.
   */
  step<T>(label: string, fn: () => T): T {
    const t0 = Date.now();
    try {
      const out = fn();
      emit('debug', [`${label} — ${Date.now() - t0}ms`]);
      return out;
    } catch (err) {
      emit('error', [`${label} — failed after ${Date.now() - t0}ms`, err]);
      throw err;
    }
  },
} as const;
