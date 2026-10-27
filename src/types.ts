// ── Platform Detection ──

export type PlatformId = 'sentinel' | 'defender';

/**
 * Tenant topology for rule filtering (#7), distinct from `PlatformId` (which
 * UI the user is on). `defender-unified` = Defender resolving both XDR and
 * Sentinel workspaces; not confirmed on a live tenant yet (see PLAN-DEV.md
 * Annexes, "Point ouvert"). Full detection/memory per tenant is phase 4/5.
 */
export type PlatformVariant = 'sentinel' | 'defender' | 'defender-unified';

export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly label: string;
  /** Does the results grid have its own right-click menu? */
  readonly cellMenu: 'native' | 'none';
  /** Target element where the inline EasyPivot button should be appended */
  getButtonInjectionTarget(): HTMLElement | null;
  /** The editor the user is actually working in (delegates to `getActiveEditor()`, #13/4f) */
  getMonacoEditor(): MonacoEditorInstance | null;
  /** Check if the current page is the Advanced Hunting page */
  isHuntingPage(): boolean;
  /**
   * Click the platform's Run button, or Shift+Enter to the editor as a
   * fallback (#22). A no-op (`'disabled'`) unless the `autoRun` setting is
   * on - project rule 4, never a query in the user's back.
   */
  runQuery(): RunOutcome;
  /** Read the results-grid cell under `target`; null = not a results cell */
  readCellContext(target: Element): CellContext | null;
  /** The grid's context menu list, if it is currently open */
  getOpenContextMenu(): HTMLElement | null;
  /** Does the grid menu (also) open on a left click on a cell? */
  readonly menuOnClick: boolean;
  /** Put a Pivot entry first in the grid menu, with the menu's own markup */
  addContextMenuItem(list: HTMLElement, label: string, onSelect: () => void): void;
  /** Close the grid menu (after the Pivot entry was chosen) */
  closeContextMenu(list: HTMLElement): void;
  /** Health diagnostic probes (N6); DOM access stays here, see core/health.ts */
  readonly healthProbes: PlatformHealthProbes;
}

// ── Health diagnostics (N6, #12) ──

/**
 * Diagnostic probe outcome. `pending` = a capability this probe set does not
 * (yet) implement, reported honestly instead of a fabricated `ok` - a
 * diagnostic that lies is worse than one that is missing. Unused as of 4g
 * (capture + tenant key are now real probes, see core/health.ts), kept in
 * the union for the same reason a future probe might need it again.
 */
export type ProbeState = 'ok' | 'warn' | 'fail' | 'pending';

export type HealthProbeId =
  | 'queryPage'
  | 'editor'
  | 'resultsGrid'
  | 'cellMenu'
  | 'runButton'
  | 'buttonAnchor'
  | 'catalog'
  | 'storage'
  | 'capture' // 4g: backed by capture/interceptor.ts's stats, see core/health.ts
  | 'tenantKey'; // 4g: backed by capture/store.ts's last resolved TenantKey

/** State + short, already-localized, data-free message (project rule 1) */
export interface ProbeOutcome {
  readonly state: ProbeState;
  readonly message: string;
}

export interface ProbeResult extends ProbeOutcome {
  readonly id: HealthProbeId;
}

/** DOM-touching probes; one implementation per adapter (selectors stay there) */
export interface PlatformHealthProbes {
  queryPage(): ProbeOutcome;
  editor(): ProbeOutcome;
  resultsGrid(): ProbeOutcome;
  cellMenu(): ProbeOutcome;
  runButton(): ProbeOutcome;
  buttonAnchor(): ProbeOutcome;
}

// ── Pivot Catalog ──

export type IndicatorId =
  | 'ip'
  | 'account'
  | 'email'
  | 'url'
  | 'domain'
  | 'device'
  | 'process'
  | 'application'
  | 'hash';

export type PivotActionId = 'statistics' | 'pivot' | 'timeline';

export interface PivotRule {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly indicators: readonly IndicatorId[];
  readonly action: PivotActionId;
  readonly description: string;
  readonly reading?: { readonly decisive?: string; readonly context?: string; readonly noise?: string };
  readonly v1?: boolean;
  readonly window: {
    readonly before: string;
    readonly after: string;
    readonly beforeMinutes: number;
    readonly afterMinutes: number;
  };
  readonly render?: string;
  readonly tables?: readonly string[];
  readonly platforms?: readonly string[];
  /** e.g. ['VALUE', 'T0', 'BEFORE_MIN', 'AFTER_MIN', 'HOST'] */
  readonly placeholders: readonly string[];
  readonly query: string;
  readonly queryDefender?: string;
}

export interface PivotCatalog {
  readonly version: string;
  /** Catalog format version (absent = legacy 1, see core/catalog-validate.ts) */
  readonly formatVersion?: number | string;
  readonly indicators: Record<IndicatorId, { readonly label: string; readonly patterns: readonly string[] }>;
  readonly actions: Record<PivotActionId, { readonly label: string }>;
  readonly rules: readonly PivotRule[];
  /** `Table.Column` pairs per indicator type, published by the rules repo (phase 2b) */
  readonly locations?: Readonly<Partial<Record<IndicatorId, readonly string[]>>>;
  /**
   * Number of entries at the HEAD of each `locations[type]` array that come
   * from the confirmed tier (rule comparison / Defender Entity) rather than
   * the uncertain tier (column-name pattern). Read by `core/detection.ts`.
   */
  readonly locationsConfirmed?: Readonly<Partial<Record<IndicatorId, number>>>;
  /** Typed in phase 6 (N4); opaque for now */
  readonly scenarios?: readonly unknown[];
}

/** What the user right-clicked in the results grid */
export interface CellContext {
  readonly value: string;
  readonly column: string;
  /** ISO 8601, '' if the row time was not found */
  readonly t0: string;
  /** Time text as displayed in the grid (tooltip) */
  readonly t0Raw: string;
  readonly host: string;
  /** Other cells of the same row present in the DOM (column → value) */
  readonly row: Readonly<Record<string, string>>;
  /**
   * Defender's own declared entity type for this cell (`context-data-schema`,
   * #18). Sentinel has no equivalent and always leaves this undefined.
   */
  readonly entityName?: string;
  /**
   * Where `row` (and, when available, `t0`/`host`) came from, most
   * trustworthy first (W2 step 1/2, #14): `'capture'` = matched against the
   * last captured `QueryRun`'s raw row; `'grid'` = the platform's own grid
   * API data (AG Grid only - Defender's DOM already holds every column);
   * `'dom'` = today's behaviour, reading the rendered cells. Required (not
   * `?`): every `CellContext` must say how it was obtained, including the
   * manual/placeholder ones built with no row at all (they use `'dom'`).
   */
  readonly source: 'capture' | 'grid' | 'dom';
  /** `QueryRun.id` this row was matched against, only set when `source === 'capture'`. */
  readonly runId?: string;
}

export interface PivotParams {
  readonly value: string;
  readonly t0?: string;
  readonly beforeMinutes?: number;
  readonly afterMinutes?: number;
  readonly host?: string;
}

// ── Investigation context (snapshots) ──

/** A rule injected from a snapshot */
export interface PivotStep {
  readonly at: number;
  readonly ruleId: string;
  readonly value: string;
  readonly indicator: IndicatorId;
}

/**
 * The context of a pivot: the event (row) it started from and the editor
 * content that produced it, so it can be pivoted again without re-running.
 */
export interface PivotSnapshot extends CellContext {
  readonly id: string;
  readonly createdAt: number;
  readonly platform: PlatformId;
  /** Editor content when the pivot was launched ('' if unavailable or too large) */
  readonly sourceQuery: string;
  /** Rule id of the last pivot query found in sourceQuery, if any */
  readonly originRuleId: string;
  readonly steps: readonly PivotStep[];
}

// ── Network capture (N1, phase 4c) ──
//
// Shared with `capture/store.ts` and `capture/summary.ts`, per the Annexes
// of docs/PLAN-DEV.md. `ParsedColumn` is structurally identical to the inline
// column shape `capture/types.ts`'s `ParsedResult.columns` already declares
// (4a/4b) — both are `{ name, type, entity? }` — so a captured result's
// columns assign into `QueryRun.columns` with no conversion step.

/** `'sentinel:<hash16>' | 'defender:<hash16>' | 'unknown'`, see `core/tenant.ts`. */
export type TenantKey = string;

export interface ParsedColumn {
  readonly name: string;
  readonly type: string; // as returned by the platform
  /** Defender's declared entity type for this column (N1) */
  readonly entity?: string;
}

/** Pure, bounded recap of a run's rows (`capture/summary.ts`). Retained even
 * after the sample is purged — see `capture/store.ts`'s retention rules. */
export interface RunSummary {
  readonly firstSeen?: string;
  readonly lastSeen?: string;
  readonly bySource?: Readonly<Record<string, number>>;
  readonly topValues?: Readonly<Record<string, readonly (readonly [string, number])[]>>;
}

/**
 * One captured query execution (`capture/store.ts`). `caseId` is a
 * placeholder (`'unassigned'`, see `UNASSIGNED_CASE_ID`) until phase 5 adds
 * `core/cases.ts` — every run uses the same literal for now.
 */
export interface QueryRun {
  readonly id: string;
  readonly caseId: string;
  readonly tenantKey: TenantKey;
  readonly platform: PlatformId;
  /** SHA-256 (hex) of the normalized KQL text */
  readonly kqlHash: string;
  /** First 300 characters of the captured KQL */
  readonly kqlPreview: string;
  /** From the `// [RULE-ID]` header `fillQuery()` writes, see `capture/store.ts` */
  readonly ruleId?: string;
  /** Pivot snapshot this run was matched to, if any (W2's `pendingRun`) */
  readonly snapshotId?: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly status: 'ok' | 'error' | 'truncated';
  readonly error?: string;
  readonly rowCount: number;
  readonly columns: readonly ParsedColumn[];
  readonly sourceTables: readonly string[];
  readonly summary: RunSummary;
  /** Capped sample, see retention rules in `capture/store.ts`; absent when not kept */
  readonly rowsSample?: readonly (readonly unknown[])[];
  readonly lastAccessAt: number;
}

// ── Editor insertion & run (W2 step 6, #13/#22) ──

/**
 * `append` (default; today's only exercised path, byte-identical to the
 * pre-4f behaviour) | `replace` (goes through the model's edit stack, so
 * Ctrl+Z restores the previous content) | `newTab`. Per the step-0 survey
 * there is a SINGLE Monaco editor shared by every tab on both platforms -
 * switching tab swaps the *model*, not the instance - so opening a genuine
 * new portal tab is not something the editor API exposes. `newTab` degrades
 * to `append` and is reported honestly via `InsertOutcome`, never silently
 * claimed as working (see core/editor-bridge.ts's `injectQuery`).
 */
export type InsertMode = 'append' | 'replace' | 'newTab';

/**
 * `injectQuery()`'s result. Extends bug #4's `'injected' | 'clipboard' |
 * 'failed'` contract with `'newTabUnsupported'`: content DID land in the
 * editor (appended), but not in a new tab as requested - distinct from
 * `'injected'` so the caller can say so instead of pretending `newTab` works.
 */
export type InsertOutcome = 'injected' | 'clipboard' | 'failed' | 'newTabUnsupported';

/**
 * `PlatformAdapter.runQuery()`'s result (#22). `disabled` = the `autoRun`
 * setting is off (project rule 4): checked inside the shared implementation
 * itself, not only by callers, so no code path can click Run unasked.
 * `unavailable` = no Run button AND no editor to send Shift+Enter to.
 */
export type RunOutcome = 'clicked' | 'fallback' | 'unavailable' | 'disabled';

// ── Monaco Editor ──

/** Minimal subset of the Monaco editor API we actually use */
export interface MonacoEditorInstance {
  getValue(): string;
  setValue(value: string): void;
  getModel(): MonacoEditorModel | null;
  getPosition(): MonacoPosition | null;
  setPosition(position: MonacoPosition): void;
  revealPositionInCenter(position: MonacoPosition): void;
  focus(): void;
}

export interface MonacoEditorModel {
  getLineCount(): number;
  getLineContent(lineNumber: number): string;
  getFullModelRange(): MonacoRange;
  getValue(): string;
  pushEditOperations(
    beforeCursorState: unknown[] | null,
    editOperations: { range: MonacoRange; text: string }[],
    cursorStateComputer: () => unknown[] | null,
  ): unknown[] | null;
}

export interface MonacoPosition {
  readonly lineNumber: number;
  readonly column: number;
}

export interface MonacoRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

// ── Storage ──

export interface CachedData<T> {
  readonly data: T;
  readonly timestamp: number;
}

// ── GM API Declarations ──

declare global {
  /**
   * Script version, injected by vite.config.ts from package.json — the same
   * source as the `{{VERSION}}` userscript-header substitution (#8). See
   * core/health.ts's `getScriptVersion()`.
   */
  const __SCRIPT_VERSION__: string;

  /** Tampermonkey's unsandboxed reference to the page's real window object */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unsafeWindow: any;

  /**
   * Firefox-only (Greasemonkey/Tampermonkey content-script global): wraps a
   * content-script function so page-world code can call it across
   * Firefox's Xray vision boundary. Undefined on Chrome and other engines -
   * always feature-detect with `typeof` before calling (see
   * capture/to-page.ts's `toPage()`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function exportFunction(fn: any, scope: any, options?: { defineAs?: string }): any;

  function GM_setValue(key: string, value: unknown): void;
  function GM_getValue<T = unknown>(key: string, defaultValue?: T): T;
  function GM_deleteValue(key: string): void;
  function GM_xmlhttpRequest(details: GMXmlHttpRequestDetails): void;

  interface GMXmlHttpRequestDetails {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    onload?: (response: GMXmlHttpResponse) => void;
    onerror?: (response: GMXmlHttpResponse) => void;
    ontimeout?: () => void;
    timeout?: number;
  }

  interface GMXmlHttpResponse {
    responseText: string;
    status: number;
    statusText: string;
  }
}