// ── Platform Detection ──

export type PlatformId = 'sentinel' | 'defender';

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
  readonly indicators: Record<IndicatorId, { readonly label: string; readonly patterns: readonly string[] }>;
  readonly actions: Record<PivotActionId, { readonly label: string }>;
  readonly rules: readonly PivotRule[];
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
