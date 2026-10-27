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