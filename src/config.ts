// ── Prefix for all CSS classes to avoid collisions with host page ──
export const CSS_PREFIX = 'shq' as const;

// ── Storage Keys ──
export const STORAGE_KEYS = {
  /** User-defined pivot rules URL ('' = default) */
  RULES_URL: 'shq_pivot_rules_url',
  /** Last downloaded catalog: { url, catalog } with timestamp */
  RULES_CACHE: 'shq_pivot_rules_cache',
  /** Investigation snapshots (pivot contexts) */
  SNAPSHOTS: 'shq_pivot_snapshots',
  /** User settings (single JSON blob, see core/settings.ts) */
  SETTINGS: 'shq_settings',
  /** Last launched rule ids, newest first (#17, see core/recent-rules.ts) */
  RECENT_RULES: 'shq_recent_rules',
  /**
   * `QueryRun[]` per tenant, prefix + tenantKey (e.g. `shq_runs_sentinel:ab12…`).
   * Since 5e-1 runs live in `shq_case_<id>`; this is the fallback buffer for a run
   * with no open case, and the source the 5c migration copies from.
   */
  RUNS_PREFIX: 'shq_runs_',
  /** `TenantKey[]` of every tenant that has a `shq_runs_<tenantKey>` entry -
   * `GM_listValues` is not declared (see core/storage.ts), so store.ts keeps
   * its own index to purge/size "everything" without it. */
  RUNS_INDEX: 'shq_runs_index',
  /**
   * Client registry (N2, phase 5a, `core/clients.ts`): `{ version: 1,
   * clients: Client[] }`. The only storage key holding a `tid` or a
   * resourceId in clear text — never included in a case export, a report,
   * an issue or the health diagnostics text.
   */
  CLIENTS: 'shq_clients',
  /**
   * Case index (N2, phase 5b, `core/cases.ts`): `{ version: 1, cases:
   * CaseIndexEntry[], activeByKey: Record<TenantKey, string> }`. Only
   * hashed `TenantKey`s and opaque client/case ids — never a `tid`, a
   * resourceId or a client name (those stay in `shq_clients` only).
   */
  CASES: 'shq_cases',
  /**
   * Prefix + case id -> `{ notes, playbook?, snapshots, runs }` (N2, phase
   * 5b). Per-case storage; the legacy `shq_pivot_snapshots` is only read
   * by the 5c migration (and written by nothing since 5e-1).
   */
  CASE_PREFIX: 'shq_case_',
  /**
   * Migration confirmation (N2 "Migration", phase 5c, `core/migration.ts`):
   * `{ confirmedAt: number }`. Written ONLY once every old snapshot and
   * every old `QueryRun` has been copied into a case — its mere presence is
   * the idempotency guard, and project rule 8 ("garde l'ancienne clé tant
   * que la migration n'est pas confirmée") is exactly what gates deleting
   * `SNAPSHOTS` / `RUNS_PREFIX` / `RUNS_INDEX` on this key being set.
   */
  MIGRATION_V2: 'shq_migration_v2',
} as const;

// ── Pivot rules catalog ──
export const DEFAULT_RULES_URL =
  'https://github.com/arthubhub/MSSentinel-PivotRules/releases/latest/download/pivot-rules.json';

/** A cached catalog older than this is refreshed in the background (12 hours) */
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Timeout for the catalog download (ms) */
export const RULES_FETCH_TIMEOUT = 15000;

// ── Investigation snapshots ──
export const SNAPSHOTS = {
  /** Oldest snapshots are dropped beyond this count */
  MAX: 30,
  /** Editor content larger than this is not stored (restore disabled) */
  MAX_SOURCE_CHARS: 50000,
  /** Row cells longer than this are truncated */
  MAX_CELL_CHARS: 2000,
} as const;

// ── Cases (N2, phase 5b) ──
export const CASES = {
  /** Oldest snapshots dropped beyond this, per case (W3: "plafond par cas (200)") */
  MAX_SNAPSHOTS_PER_CASE: 200,
  /**
   * Import guard (5d, `core/case-export.ts`): a file longer than this is
   * refused BEFORE `JSON.parse`, so a 50 MB pick cannot freeze the page.
   * Same order of magnitude as `retention.maxBytes` (20 MB) on purpose: a
   * single case cannot legitimately be larger than the whole local store's
   * cap.
   */
  MAX_IMPORT_CHARS: 20_000_000,
  /** Import guard (5d): `QueryRun`s kept from one imported file, newest first. */
  MAX_IMPORT_RUNS: 1000,
  /**
   * Live `QueryRun`s kept per case body (5e-1). The tenant buffer this replaces
   * was capped at 50 per tenant; without a cap here a case body would grow
   * (and be rewritten whole on every captured query) until `retention.maxBytes`.
   * Oldest unlinked runs go first (see `core/cases.ts` `capRuns`).
   */
  MAX_RUNS_PER_CASE: 200,
  /** Pinned evidence rows per snapshot, enforced on import (5e-1; the pin UI is 5e-2). */
  MAX_PINNED_ROWS: 50,
  /** Snapshot note length, enforced on import (5e-1; the note UI is 5e-2). */
  MAX_NOTE_CHARS: 10_000,
} as const;

// ── Recent rules (#17) ──
/** Oldest recent rule ids are dropped beyond this count */
export const RECENT_RULES_MAX = 10;

// ── Platform-specific Selectors ──
export const SELECTORS = {
  /** MS Defender (security.microsoft.com) */
  DEFENDER: {
    /** The command bar above the hunting editor */
    COMMAND_BAR: '.scc-commandBar',
    /** The main content area */
    MAIN_CONTENT: '.scc-sidePanelPage-mainContent',
    /** Run query button */
    RUN_BUTTON: '#huntingRunQueryButtonId',
    /** The button is appended to this element's parent (after it, last child) */
    BUTTON_ANCHOR: '#Join_Queries_Bubble_Advanced_Hunting_Query_Editor',
    /** Results grid (Fluent UI DetailsList) */
    GRID_ROW: '[role="row"].ms-DetailsRow',
    GRID_CELL: '[role="gridcell"][data-automation-key]',
    /** Element of a cell that carries the full value and the column name */
    GRID_VALUE: '[context-data-property]',
    /** Open Fluent UI context menu (cell menu: « Ajouter … == … », « Copier … ») */
    CONTEXT_MENU_LIST: '.ms-ContextualMenu-Callout .ms-ContextualMenu-list.is-open',
  },
  /** MS Sentinel (portal.azure.com via reactblade iframe) */
  SENTINEL: {
    /** The discover wrapper */
    DISCOVER_WRAPPER: '#DiscoverWrapper',
    /** Run query button (step-0 survey, health diagnostic N6) */
    RUN_BUTTON: '#logs-main-run-button',
    /** The left-side KQL mode panel (contains Run, time picker, etc.) */
    KQL_PANEL: '[data-logs-query-controls-bar]',
    /** AG Grid root of the results view */
    GRID_ROOT: '.logs-results-grid .ag-root',
    GRID_CELL: '[role="gridcell"][col-id]',
    GRID_ROW: '[role="row"][row-index]',
    GRID_HEADER_CELL: '[role="columnheader"][col-id]',
    /** Class set by AG Grid while its context menu is open */
    CONTEXT_MENU_OPEN: '.ag-root.ag-context-menu-open',
    CONTEXT_MENU_LIST: '.ag-menu-list',
  },
} as const;

// ── Pivot ──
export const PIVOT = {
  /** T0 source columns, by priority */
  TIME_COLUMNS: ['TimeGenerated', 'Timestamp', 'TimeCreated', 'EventTime'],
  /** HOST source columns, by priority */
  HOST_COLUMNS: ['DeviceName', 'Computer', 'HostName', 'Hostname', 'DeviceHostName'],
  /** Most specific first: used to preselect a type when several patterns match */
  INDICATOR_PRIORITY: ['ip', 'hash', 'application', 'url', 'email', 'process', 'domain', 'device', 'account'],
  /** AG Grid columns that never hold a pivotable value */
  IGNORED_COLUMNS: ['ag-Grid-SelectionColumn'],
  /** Max wait for the grid menu after the click */
  MENU_WAIT_MS: 800,
  /** Marks the Pivot entry added to a grid menu (and its separator) */
  MENU_ITEM_CLASS: `${CSS_PREFIX}-pivot-option`,
  MENU_SEPARATOR_CLASS: `${CSS_PREFIX}-pivot-option-separator`,
} as const;

// ── Notification duration ──
export const NOTIFICATION_DURATION_MS = 3000;

// ── Capture store (N1, phase 4c) ──
export const CAPTURE_STORE = {
  /** Circular buffer size per tenant key (N1 "tampon circulaire … 50 derniers") */
  MAX_RUNS_PER_TENANT: 50,
  /** `QueryRun.kqlPreview` length */
  KQL_PREVIEW_CHARS: 300,
  /** Sample cell truncation (N1 "cellules tronquées à 2 000 caractères") */
  MAX_SAMPLE_CELL_CHARS: 2000,
  /** How long a W2 `pendingRun` stays eligible for matching before it is dropped as stale */
  PENDING_RUN_TTL_MS: 10 * 60 * 1000,
  /** Purge cadence (N1 "une fois par heure") */
  RETENTION_PURGE_INTERVAL_MS: 60 * 60 * 1000,
} as const;