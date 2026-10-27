import type {
  HealthProbeId,
  PlatformAdapter,
  PlatformId,
  ProbeOutcome,
  ProbeResult,
  ProbeState,
} from '../types.ts';
import { STORAGE_KEYS } from '../config.ts';
import { copyText } from './editor-bridge.ts';
import { getCatalogStatus } from './rules-catalog.ts';
import { resolvePlatformVariant, getSetting } from './settings.ts';
import { estimateStorageBytes } from './storage.ts';
import { isUnknownTenantKey } from './tenant.ts';
import { getCaptureStats, onCaptureResult } from '../capture/interceptor.ts';
import { getLastResolvedTenantKey } from '../capture/store.ts';
import { t, type MessageKey } from '../i18n/index.ts';

/**
 * Health diagnostics (N6, #12). A probe never throws (each is wrapped
 * individually in `runHealthProbes`) and never carries data - only short,
 * already-localized messages (project rule 1).
 *
 * DOM-touching probes live in each adapter's `healthProbes`
 * (src/platforms/sentinel.ts, src/platforms/defender.ts); this module
 * orchestrates them plus the DOM-free probes: catalog, storage, and - since
 * 4g - capture and tenant key, backed by `capture/interceptor.ts`'s stats
 * and `capture/store.ts`'s last resolved `TenantKey`.
 */

export interface HealthReport {
  readonly platformId: PlatformId;
  readonly generatedAt: number;
  readonly probes: readonly ProbeResult[];
}

// ── Shared, DOM-free probe building blocks (reused by both adapters) ──

/** A structural landmark is either there or it isn't; no 'warn' in between. */
export function landmarkProbe(present: boolean): ProbeOutcome {
  return present
    ? { state: 'ok', message: t('health.landmarkFound') }
    : { state: 'fail', message: t('health.landmarkMissing') };
}

/** Editor probe: fail on 0, warn on >1, ok on exactly 1 (identical on both platforms) */
export function editorCountProbe(count: number): ProbeOutcome {
  if (count === 0) return { state: 'fail', message: t('health.editor.none') };
  if (count > 1) return { state: 'warn', message: t('health.editor.multiple') };
  return { state: 'ok', message: t('health.editor.one') };
}

/**
 * Results grid probe factory. Without the capture layer (phase 4) there is
 * no reliable "a query just succeeded" signal, so absence alone is not a
 * `fail` - that would turn every fresh page load (no query run yet) into a
 * false alarm. Instead this tracks "has the grid ever rendered in this
 * session"; only a grid that disappears *after* being seen is a `fail`.
 * Each adapter module calls this once and keeps its own instance (own
 * closure state), since the two selectors are independent checks.
 */
export function createResultsGridProbe(): (present: boolean) => ProbeOutcome {
  let everSeen = false;
  return (present: boolean): ProbeOutcome => {
    if (present) {
      everSeen = true;
      return { state: 'ok', message: t('health.grid.ok') };
    }
    return everSeen
      ? { state: 'fail', message: t('health.grid.lost') }
      : { state: 'warn', message: t('health.grid.notYet') };
  };
}

// ── Cell menu (recorded by ui/pivot-trigger.ts on the last right-click) ──

/**
 * Whether the Pivot entry was actually present after the last attempt to
 * add it to the grid's native context menu. Set from ui/pivot-trigger.ts,
 * the only place that knows when a right-click happened; this module just
 * remembers the last outcome. Not DOM access itself (no adapter needed),
 * and identical on both platforms, hence shared rather than per-adapter.
 */
let lastCellMenuHadEntry: boolean | null = null;

export function recordCellMenuOutcome(hasEntry: boolean): void {
  lastCellMenuHadEntry = hasEntry;
}

export function cellMenuProbe(): ProbeOutcome {
  if (lastCellMenuHadEntry === null) return { state: 'warn', message: t('health.menu.notYet') };
  return lastCellMenuHadEntry
    ? { state: 'ok', message: t('health.menu.ok') }
    : { state: 'fail', message: t('health.menu.missingEntry') };
}

// ── Catalog (reuses #11's own validation report, see STATE.md 1e decision) ──

function catalogProbe(): ProbeOutcome {
  const status = getCatalogStatus();
  if (status.error) return { state: 'fail', message: t('health.catalog.blocked') };
  if (status.warnings.length > 0) {
    const n = status.warnings.length;
    return { state: 'warn', message: t('health.catalog.warnings', { n, s: n > 1 ? 's' : '' }) };
  }
  return { state: 'ok', message: t('health.catalog.ok') };
}

// ── Storage (N6, Annexes `retention.maxBytes`) ──

const STORAGE_PROBE_KEYS: readonly string[] = [
  STORAGE_KEYS.RULES_URL,
  STORAGE_KEYS.RULES_CACHE,
  STORAGE_KEYS.SNAPSHOTS,
  STORAGE_KEYS.SETTINGS,
];

const STORAGE_WARN_RATIO = 0.8;

function storageProbe(): ProbeOutcome {
  const { maxBytes } = getSetting('retention');
  const used = estimateStorageBytes(STORAGE_PROBE_KEYS);
  const pct = maxBytes > 0 ? Math.round((used / maxBytes) * 100) : 0;

  if (maxBytes <= 0 || used < maxBytes * STORAGE_WARN_RATIO) {
    return { state: 'ok', message: t('health.storage.ok', { pct }) };
  }
  if (used < maxBytes) return { state: 'warn', message: t('health.storage.warn', { pct }) };
  return { state: 'fail', message: t('health.storage.fail', { pct }) };
}

// ── Capture (N6, 4g) ──
//
// Three situations, must not be conflated (N6 + phase-4 report):
//   - disabled by setting: a deliberate choice, not a failure -> `warn`
//     (not `ok`: the capture feature genuinely is not running, and this
//     probe should say so without raising a false alarm).
//   - enabled, nothing matched yet (page just loaded, no query run) -> `warn`,
//     same "not yet" shape as the Grid/Menu probes above.
//   - enabled, at least one matched request parsed into a result -> `ok`.
//   - enabled, a matched request produced NO `ParsedResult` -> `fail`: the
//     real signal that the portal's endpoint/response shape moved and a
//     profile stopped matching it.
// `unparsed > 0` wins over `parsed > 0`: one broken parse is worth
// surfacing even if earlier requests this session still worked.
function captureProbe(): ProbeOutcome {
  let enabled: boolean;
  try {
    enabled = getSetting('capture').enabled;
  } catch {
    enabled = true; // a broken setting read must not hide a real probe result
  }
  if (!enabled) return { state: 'warn', message: t('health.capture.disabled') };

  const { parsed, unparsed } = getCaptureStats();
  if (unparsed > 0) return { state: 'fail', message: t('health.capture.unparsed', { n: unparsed }) };
  if (parsed > 0) return { state: 'ok', message: t('health.capture.ok', { n: parsed }) };
  return { state: 'warn', message: t('health.capture.notYet') };
}

// ── Tenant key (N6, 4g) ──
//
// `sentinelKey`/`defenderKey` (core/tenant.ts) are async; this probe is not,
// so it reads the key `capture/store.ts` already resolved for the most
// recent captured request rather than awaiting a fresh one. `warn`, never
// `fail`, on an absent key (N2 point 4: pivot stays allowed, routed to an
// "unassigned" case) - and no value or hash in the message either way
// (hard constraint: the diagnostics text stays value-free).
function tenantKeyProbe(): ProbeOutcome {
  const key = getLastResolvedTenantKey();
  if (key !== null && !isUnknownTenantKey(key)) {
    return { state: 'ok', message: t('health.tenantKey.ok') };
  }
  return { state: 'warn', message: t('health.tenantKey.warn') };
}

// ── Runner ──

function safe(id: HealthProbeId, run: () => ProbeOutcome): ProbeResult {
  try {
    return { id, ...run() };
  } catch {
    return { id, state: 'fail', message: t('health.msg.probeError') };
  }
}

export function runHealthProbes(platform: PlatformAdapter): HealthReport {
  const p = platform.healthProbes;
  const probes: readonly ProbeResult[] = [
    safe('queryPage', () => p.queryPage()),
    safe('editor', () => p.editor()),
    safe('resultsGrid', () => p.resultsGrid()),
    safe('cellMenu', () => p.cellMenu()),
    safe('runButton', () => p.runButton()),
    safe('buttonAnchor', () => p.buttonAnchor()),
    safe('catalog', catalogProbe),
    safe('storage', storageProbe),
    safe('capture', captureProbe), // 4g
    safe('tenantKey', tenantKeyProbe), // 4g
  ];
  return { platformId: platform.id, generatedAt: Date.now(), probes };
}

export function hasFailure(report: HealthReport | null): boolean {
  return report?.probes.some((p) => p.state === 'fail') ?? false;
}

// ── Shared last report + pub/sub (mirrors core/rules-catalog.ts) ──

let lastReport: HealthReport | null = null;
const listeners = new Set<() => void>();

export function getHealthReport(): HealthReport | null {
  return lastReport;
}

export function onHealthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Runs the probes now, publishes the result (badge, open panel, ...). */
export function refreshHealth(platform: PlatformAdapter): HealthReport {
  lastReport = runHealthProbes(platform);
  for (const fn of listeners) fn();
  return lastReport;
}

/**
 * Third N6 trigger ("after each captured query"): wired in 4g from
 * `main.ts`, which subscribes to `capture/interceptor.ts`'s
 * `onCaptureResult()` and calls this function. Not subscribed from inside
 * this module: `core/health.ts` is only ever handed a `PlatformAdapter` by
 * its caller (see `refreshHealth`, `runHealthProbes`) and keeps no
 * module-level reference of its own - `main.ts` already holds the active
 * one as bootstrap state, so it is the natural place to forward the event.
 * Fires once per matched request, parsed or not (see `captureProbe()`).
 */
export function onQueryCaptured(platform: PlatformAdapter): void {
  void refreshHealth(platform);
}

// ── Script version (same package.json source as the {{VERSION}} header, #8) ──

export function getScriptVersion(): string {
  return typeof __SCRIPT_VERSION__ === 'string' ? __SCRIPT_VERSION__ : '';
}

// ── Display labels (used by health-view.ts and the diagnostics text) ──

const PROBE_LABEL_KEY: Record<HealthProbeId, MessageKey> = {
  queryPage: 'health.probe.queryPage',
  editor: 'health.probe.editor',
  resultsGrid: 'health.probe.resultsGrid',
  cellMenu: 'health.probe.cellMenu',
  runButton: 'health.probe.runButton',
  buttonAnchor: 'health.probe.buttonAnchor',
  catalog: 'health.probe.catalog',
  storage: 'health.probe.storage',
  capture: 'health.probe.capture',
  tenantKey: 'health.probe.tenantKey',
};

const STATE_LABEL_KEY: Record<ProbeState, MessageKey> = {
  ok: 'health.state.ok',
  warn: 'health.state.warn',
  fail: 'health.state.fail',
  pending: 'health.state.pending',
};

export function getProbeLabel(id: HealthProbeId): string {
  return t(PROBE_LABEL_KEY[id]);
}

export function getStateLabel(state: ProbeState): string {
  return t(STATE_LABEL_KEY[state]);
}

// ── "Copy diagnostics" (privacy-critical: whitelist only) ──

/**
 * Everything the diagnostics text is allowed to contain. Built field by
 * field from known-safe sources: never spread or serialize `HealthReport`,
 * `CatalogStatus` or any other object wholesale - a field added to one of
 * those later must be added here explicitly, or it stays out. This is what
 * makes "Copy diagnostics" safe to hand to the user (project rule 1): no
 * IOC value, tenant/workspace key, client name, case name, query or `_CL`
 * table name ever flows through this function.
 */
export interface DiagnosticsContext {
  readonly platformLabel: string;
  readonly platformVariant: string;
  readonly userAgent: string;
  readonly catalogVersion: string;
  /** Already leak-free: produced by core/catalog-validate.ts (see 1d) */
  readonly catalogWarnings: readonly string[];
}

export function gatherDiagnosticsContext(platform: PlatformAdapter): DiagnosticsContext {
  const status = getCatalogStatus();
  return {
    platformLabel: platform.label,
    platformVariant: resolvePlatformVariant(platform.id),
    userAgent: navigator.userAgent,
    catalogVersion: status.version,
    catalogWarnings: status.warnings,
  };
}

export function buildDiagnosticsText(report: HealthReport, ctx: DiagnosticsContext): string {
  const lines: string[] = [
    `EasyPivot v${getScriptVersion()}`,
    `${t('health.diag.platform')}: ${ctx.platformLabel} (${ctx.platformVariant})`,
    `${t('health.diag.browser')}: ${ctx.userAgent}`,
    `${t('health.diag.catalog')}: v${ctx.catalogVersion}`,
    '',
  ];
  for (const probe of report.probes) {
    lines.push(`- ${getProbeLabel(probe.id)}: ${getStateLabel(probe.state)} — ${probe.message}`);
  }
  if (ctx.catalogWarnings.length > 0) {
    lines.push('', t('settings.catalogWarningsLabel'));
    for (const w of ctx.catalogWarnings) lines.push(`- ${w}`);
  }
  return lines.join('\n');
}

/** Builds the text and copies it; runs the probes first if none have run yet. */
export async function copyDiagnostics(platform: PlatformAdapter): Promise<'clipboard' | 'failed'> {
  const report = getHealthReport() ?? refreshHealth(platform);
  const text = buildDiagnosticsText(report, gatherDiagnosticsContext(platform));
  return copyText(text);
}
