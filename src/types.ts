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
  /** Attempt to get the Monaco editor instance on the page */
  getMonacoEditor(): MonacoEditorInstance | null;
  /** Check if the current page is the Advanced Hunting page */
  isHuntingPage(): boolean;
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
 * Diagnostic probe outcome. `pending` = the capability is not implemented
 * yet (capture + tenant key, phase 4 item 4g) and is never reported as a
 * fabricated `ok` — a diagnostic that lies is worse than one that is missing.
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
  | 'capture' // phase 4 (4g): needs the capture layer, not implemented here
  | 'tenantKey'; // phase 4 (4g): needs core/tenant.ts, not implemented here

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