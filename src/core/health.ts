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
import { t, type MessageKey } from '../i18n/index.ts';

/**
 * Health diagnostics (N6, #12). A probe never throws (each is wrapped
 * individually in `runHealthProbes`) and never carries data - only short,
 * already-localized messages (project rule 1).
 *
 * DOM-touching probes live in each adapter's `healthProbes`
 * (src/platforms/sentinel.ts, src/platforms/defender.ts); this module
 * orchestrates them plus the two DOM-free probes (catalog, storage) and the
 * two probes this phase does not implement (capture, tenant key - phase 4
 * item 4g: they need the capture layer and core/tenant.ts, neither of which
 * exists yet). Those two are reported `pending`, never a fabricated `ok`.
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

// ── Deferred probes (phase 4, item 4g) ──

function pendingProbe(): ProbeOutcome {
  return { state: 'pending', message: t('health.pending') };
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
    safe('capture', pendingProbe), // 4g
    safe('tenantKey', pendingProbe), // 4g
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
 * Third N6 trigger ("after each captured query"): not wired yet, the
 * capture layer does not exist (phase 4). Call this from capture/store.ts
 * once a QueryRun is recorded, so the Results grid / Capture probes reflect
 * the query that was just seen.
 */
export function onQueryCaptured(_platform: PlatformAdapter): void {
  // phase 4: void refreshHealth(_platform);
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
