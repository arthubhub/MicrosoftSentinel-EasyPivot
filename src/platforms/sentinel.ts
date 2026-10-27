import type { MonacoEditorInstance, PlatformAdapter, PlatformHealthProbes, RunOutcome } from '../types.ts';
import { SELECTORS } from '../config.ts';
import { getActiveEditor, getMonacoEditorCount, runQuery as triggerRun } from '../core/editor-bridge.ts';
import { cellMenuProbe, createResultsGridProbe, editorCountProbe, landmarkProbe } from '../core/health.ts';
import {
  addAgGridMenuItem,
  closeAgGridContextMenu,
  getOpenAgGridContextMenu,
  readAgGridCellContext,
} from './ag-grid.ts';

const S = SELECTORS.SENTINEL;

/** Own closure state (has the grid ever rendered this session?), see core/health.ts */
const resultsGridProbe = createResultsGridProbe();

/** DOM-touching diagnostic probes (N6, #12); logic shared via core/health.ts */
const healthProbes: PlatformHealthProbes = {
  queryPage: () => landmarkProbe(document.querySelector(S.DISCOVER_WRAPPER) !== null),
  editor: () => editorCountProbe(getMonacoEditorCount()),
  resultsGrid: () => resultsGridProbe(document.querySelector(S.GRID_ROOT) !== null),
  cellMenu: cellMenuProbe,
  runButton: () => landmarkProbe(document.querySelector(S.RUN_BUTTON) !== null),
  buttonAnchor: () => landmarkProbe(document.querySelector(S.KQL_PANEL) !== null),
};

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

  getButtonInjectionTarget(): HTMLElement | null {
    // Insert into the left-side KQL mode panel only, so the button sits
    // inline with Run, time picker, etc.
    return document.querySelector<HTMLElement>(SELECTORS.SENTINEL.KQL_PANEL);
  },

  getMonacoEditor(): MonacoEditorInstance | null {
    // 4f fix: this used to call getMonacoEditorInstance() (= getEditors()[0])
    // and nobody called it, so the trap left by 1f went unnoticed. Delegates
    // to getActiveEditor() now - the same resolution injectQuery() uses.
    return getActiveEditor();
  },

  isHuntingPage(): boolean {
    return document.querySelector(SELECTORS.SENTINEL.DISCOVER_WRAPPER) !== null;
  },

  runQuery(): RunOutcome {
    return triggerRun(document.querySelector<HTMLElement>(S.RUN_BUTTON));
  },

  readCellContext: readAgGridCellContext,

  getOpenContextMenu: getOpenAgGridContextMenu,

  menuOnClick: false,

  addContextMenuItem: addAgGridMenuItem,

  closeContextMenu: closeAgGridContextMenu,

  healthProbes,
};