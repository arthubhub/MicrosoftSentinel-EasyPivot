import type { MessageKey } from './fr.ts';

/**
 * English dictionary — natural wording, not a word-for-word gloss of `fr.ts`.
 * Typed against `MessageKey` so a missing or extra key is a compile error.
 */
export const en: Record<MessageKey, string> = {
  // ── Common ──
  'common.pivot': 'Pivot',
  'common.close': 'Close',
  'common.default': 'default',

  // ── Inline button ──
  'button.title': 'EasyPivot: event history, manual pivot and settings',

  // ── Context menu (grid right-click) ──
  'menu.pivotWithType': 'Pivot · {label}',

  // ── Panel chrome ──
  'panel.settingsTitle': 'Settings',
  'panel.closeTitle': 'Close (Esc)',

  // ── Panel · context (investigation journal) ──
  'panel.context.eventLabel': 'Event',
  'panel.context.restoreLabel': '↶ Source query',
  'panel.context.currentClick': 'Current click · {column} = {value}',
  'panel.context.chooseEvent': '— Choose an event —',
  'panel.context.noEvent': 'No event recorded',
  'panel.context.sourceNotSaved': 'Source query not saved (editor empty or too large)',
  'panel.context.restoreHint':
    'Puts back in the editor the query that produced this event (Ctrl+Z to undo)',
  'panel.context.fieldsLabel': 'Row fields',
  'panel.context.pivotsLaunched': 'Pivots run: ',
  'panel.context.originSuffix': ' · from {id}',
  'panel.context.stepsSuffix': ' · {n} pivot{s}',

  // ── Panel · params ──
  'panel.params.valueLabel': 'Value',
  'panel.params.valuePlaceholder': 'Value to pivot on',
  'panel.params.t0Label': 'T0 (UTC)',
  'panel.params.t0Placeholder': 'empty = now()',
  'panel.params.t0ReadFromGrid': 'Read from the grid: {raw}',
  'panel.params.t0NotFound': 'Row time not found',
  'panel.params.beforeLabel': 'Before',
  'panel.params.afterLabel': 'After',
  'panel.params.windowHint': 'Minutes, or 30m, 24h, 7d. Empty = default window',
  'panel.params.hostLabel': 'Machine (Process / Hash rules)',
  'panel.params.hostPlaceholder': 'empty = all',
  'panel.params.typeMatches': 'The value matches this type',
  'panel.params.typeMismatch': 'The value does not match this type, pivoting is still possible',

  // ── Panel · rules ──
  'panel.rules.injectTitle': 'Inject the query into the editor',
  'panel.rules.ranBadge': '✓ run',
  'panel.rules.ranTitle': 'Already run on this value from this event',
  'panel.rules.detailsTitle': 'Details',
  'panel.rules.readingDecisive': 'Decisive: ',
  'panel.rules.readingContext': 'Context: ',
  'panel.rules.readingNoise': 'Noise: ',
  'panel.rules.noRules': 'No rule for this type',
  'panel.rules.hiddenForPlatform': '{n} rule{s} hidden for this platform',

  // ── Panel · settings ──
  'settings.ageNow': 'just now',
  'settings.ageMinutes': '{n} min ago',
  'settings.ageHours': '{n} h ago',
  'settings.ageDays': '{n} d ago',
  'settings.rulesUrlLabel': 'Pivot rules catalog URL',
  'settings.saveReload': 'Save and reload',
  'settings.defaultUrl': 'Default URL',
  'settings.clearHistory': 'Clear history',
  'settings.sourceBundled': 'bundled with the script',
  'settings.sourceCache': 'cache ({age})',
  'settings.sourceRemote': 'downloaded ({age})',
  'settings.catalogStatus': 'Catalog v{version} · {count} rules · {source}',
  'settings.downloadFailed': 'Download failed: {error}',
  'settings.downloading': 'Downloading…',
  'settings.catalogWarningsLabel': 'Catalog warnings:',

  // ── Toasts ──
  'notify.emptyValue': 'Empty value',
  'notify.invalidWindow': 'Invalid window: minutes, or 30m, 24h, 7d',
  'notify.invalidT0': 'Invalid T0: expected ISO format (2026-10-08T09:21:14Z)',
  'notify.timeSelectorHint': ' Time picker: "Set in query"',
  'notify.ruleInjected': '{id} injected.{hint}',
  'notify.ruleCopied': '{id} copied to clipboard',
  'notify.injectFailed': 'Could not inject the query',
  'notify.clipboardDenied': 'Clipboard access denied, query not copied',
  'notify.sourceRestored': 'Source query restored (Ctrl+Z to undo)',
  'notify.editorNotFound': 'Editor not found',
  'notify.catalogDownloadFailed': 'Catalog not downloaded, previous version kept',
  'notify.catalogLoaded': 'Catalog v{version} loaded ({count} rules)',
  'notify.historyCleared': 'Event history cleared',
  'notify.diagnosticsCopied': 'Diagnostics copied to clipboard',
  'notify.diagnosticsCopyFailed': 'Clipboard access denied, diagnostics not copied',

  // ── Catalog errors (surfaced in the settings status line) ──
  'error.invalidJson': 'invalid JSON',
  'error.networkError': 'network error',
  'error.timeout': 'timed out',
  'error.unexpectedCatalogFormat': 'unexpected catalog format',

  // ── Catalog validation (#11) ──
  'error.catalogRejected': 'catalog rejected: {reason}',
  'validate.formatVersionUnsupported':
    'formatVersion {version} is not supported (expected {min} to {max})',
  'validate.formatVersionInvalid': 'unreadable formatVersion: “{version}”',
  'validate.unknownPlaceholder': 'rule {id}: unknown placeholder “{name}”',
  'validate.unknownIndicator': 'rule {id}: unknown indicator type “{name}”',
  'validate.noKnownIndicator': 'rule {id}: no known indicator type, rule unreachable',
  'validate.unknownAction': 'rule {id}: unknown action “{name}”',
  'validate.badPattern': 'type {type}: regular expression #{n} does not compile',
  'validate.noPatterns': 'type {type}: no valid regular expression, automatic detection unavailable',
  'validate.unknownLocationType': 'locations: unknown type “{type}” ignored',
  'validate.badLocation': 'locations {type}: entry “{entry}” ignored (expected Table.Column)',
  'validate.locationsCustomTable': 'locations {type}: {n} custom-table column{s} ignored',
  'validate.noRules': 'no usable rule in the catalog',

  // ── Health diagnostics (N6, #12) ──
  'health.title': 'Health diagnostics',
  'health.refresh': 'Refresh',
  'health.copy': 'Copy diagnostics',
  'health.notRun': 'Diagnostics not run yet',
  'health.diag.platform': 'Platform',
  'health.diag.browser': 'Browser',
  'health.diag.catalog': 'Catalog',
  'health.probe.queryPage': 'Query page',
  'health.probe.editor': 'Editor',
  'health.probe.resultsGrid': 'Results grid',
  'health.probe.cellMenu': 'Cell menu',
  'health.probe.runButton': 'Run button',
  'health.probe.buttonAnchor': 'Button anchor',
  'health.probe.catalog': 'Catalog',
  'health.probe.storage': 'Storage',
  'health.probe.capture': 'Capture',
  'health.probe.tenantKey': 'Tenant key',
  'health.state.ok': 'OK',
  'health.state.warn': 'Warning',
  'health.state.fail': 'Failed',
  'health.state.pending': 'Not available',
  'health.msg.probeError': 'probe failed to run',
  'health.landmarkFound': 'element detected',
  'health.landmarkMissing': 'element not found',
  'health.editor.none': 'no Monaco editor detected',
  'health.editor.one': 'editor detected',
  'health.editor.multiple': 'multiple editors detected',
  'health.grid.ok': 'grid detected',
  'health.grid.notYet': 'not observed yet',
  'health.grid.lost': 'grid disappeared after a query',
  'health.menu.ok': 'Pivot entry present on the last right-click',
  'health.menu.notYet': 'no right-click observed yet',
  'health.menu.missingEntry': 'Pivot entry missing on the last right-click',
  'health.catalog.ok': 'no warning',
  'health.catalog.warnings': '{n} warning{s}',
  'health.catalog.blocked': 'catalog rejected (blocking error)',
  'health.storage.ok': '{pct}% used',
  'health.storage.warn': '{pct}% used (80% threshold exceeded)',
  'health.storage.fail': 'quota exceeded ({pct}%)',
  'health.pending': 'not available yet (phase 4)',
};
