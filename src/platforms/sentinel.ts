import type { ButtonAnchor, MonacoEditorInstance, PlatformAdapter } from '../types.ts';
import { SELECTORS } from '../config.ts';
import { getMonacoEditorInstance } from '../core/editor-bridge.ts';
import { getOpenAgGridContextMenu, readAgGridCellContext } from './ag-grid.ts';

/**
 * MS Sentinel (Azure Portal) platform adapter.
 *
 * Sentinel's Advanced Hunting runs inside an iframe on reactblade.portal.azure.net.
 * The KQL editor uses Monaco (exposed via window.monaco).
 *
 * Key DOM landmarks:
 * - #DiscoverWrapper                     - main hunting wrapper
 * - .left-side.kql-mode-panel            - left panel (Run button, time picker, KQL mode)
 * - .logs-results-grid .ag-root          - results grid (AG Grid)
 *
 * The results grid has its own right-click menu ('native'): the Pivot entry
 * is added to it. If that menu turns out to open on left click only, switch
 * to 'none' and the right-click opens the Pivot panel directly.
 */
export const sentinelAdapter: PlatformAdapter = {
  id: 'sentinel',
  label: 'Microsoft Sentinel',
  cellMenu: 'native',

  getButtonAnchor(): ButtonAnchor | null {
    // Insert into the left-side KQL mode panel only, so the button sits
    // inline with Run, time picker, etc.
    const container = document.querySelector<HTMLElement>(SELECTORS.SENTINEL.KQL_PANEL);
    return container ? { container } : null;
  },

  getMonacoEditor(): MonacoEditorInstance | null {
    return getMonacoEditorInstance();
  },

  isHuntingPage(): boolean {
    return document.querySelector(SELECTORS.SENTINEL.DISCOVER_WRAPPER) !== null;
  },

  readCellContext: readAgGridCellContext,

  getOpenContextMenu: getOpenAgGridContextMenu,
};
