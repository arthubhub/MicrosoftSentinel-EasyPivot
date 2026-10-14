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

// ── Platform-specific Selectors ──
export const SELECTORS = {
  /** MS Defender (security.microsoft.com) */
  DEFENDER: {
    /** Run query button: the button is anchored next to it */
    RUN_BUTTON: '#huntingRunQueryButtonId',
    /** Slot of a command in the bar (Fluent OverflowSet item, or split button container) */
    COMMAND_SLOT: '.ms-OverflowSet-item, [class*="splitButtonContainer"]',
    /** Command bar buttons whose generated classes are copied */
    COMMAND_BUTTON: '.ms-Button.ms-Button--commandBar',
  },
  /** MS Sentinel (portal.azure.com via reactblade iframe) */
  SENTINEL: {
    /** The discover wrapper */
    DISCOVER_WRAPPER: '#DiscoverWrapper',
    /** The left-side KQL mode panel (contains Run, time picker, etc.) */
    KQL_PANEL: '.left-side.kql-mode-panel',
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
  /** Max wait for the AG Grid menu after the right-click */
  MENU_WAIT_MS: 800,
} as const;

// ── Notification duration ──
export const NOTIFICATION_DURATION_MS = 3000;
