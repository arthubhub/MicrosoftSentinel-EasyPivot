import type { MonacoEditorInstance, PlatformAdapter, PlatformHealthProbes, RunOutcome } from '../types.ts';
import { SELECTORS } from '../config.ts';
import { getActiveEditor, getMonacoEditorCount, runQuery as triggerRun } from '../core/editor-bridge.ts';
import { cellMenuProbe, createResultsGridProbe, editorCountProbe, landmarkProbe } from '../core/health.ts';
import {
  addFluentMenuItem,
  closeFluentContextMenu,
  getOpenFluentContextMenu,
  readFluentCellContext,
} from './fluent-grid.ts';

const D = SELECTORS.DEFENDER;

/** Own closure state (has the grid ever rendered this session?), see core/health.ts */
const resultsGridProbe = createResultsGridProbe();

/**
 * DOM-touching diagnostic probes (N6, #12). Defender has no separate
 * "wrapper" landmark: the Run button itself is also used to detect the
 * hunting page (same selector as `isHuntingPage()` below).
 */
const healthProbes: PlatformHealthProbes = {
  queryPage: () => landmarkProbe(document.querySelector(D.RUN_BUTTON) !== null),
  editor: () => editorCountProbe(getMonacoEditorCount()),
  resultsGrid: () => resultsGridProbe(document.querySelector(D.GRID_ROW) !== null),
  cellMenu: cellMenuProbe,
  runButton: () => landmarkProbe(document.querySelector(D.RUN_BUTTON) !== null),
  buttonAnchor: () => landmarkProbe(document.querySelector(D.BUTTON_ANCHOR)?.parentElement != null),
};

/**
 * MS Defender (security.microsoft.com) platform adapter.
 *
 * Key DOM landmarks:
 * - #huntingRunQueryButtonId                         - Run query button (page detection)
 * - #Join_Queries_Bubble_Advanced_Hunting_Query_Editor - the button is appended to its parent
 * - [role=row].ms-DetailsRow                         - results grid (Fluent UI DetailsList)
 * - .ms-ContextualMenu-Callout .ms-ContextualMenu-list - cell menu
 *
 * The results grid has its own cell menu ('native'): the Pivot entry is put
 * first in it. It is watched after a right-click and after a left click
 * (menuOnClick), whichever opens it.
 */
export const defenderAdapter: PlatformAdapter = {
  id: 'defender',
  label: 'Microsoft Defender',
  cellMenu: 'native',

  getButtonInjectionTarget(): HTMLElement | null {
    return document.querySelector<HTMLElement>(SELECTORS.DEFENDER.BUTTON_ANCHOR)?.parentElement ?? null;
  },

  getMonacoEditor(): MonacoEditorInstance | null {
    // 4f fix: this used to call getMonacoEditorInstance() (= getEditors()[0])
    // and nobody called it, so the trap left by 1f went unnoticed. Delegates
    // to getActiveEditor() now - the same resolution injectQuery() uses.
    return getActiveEditor();
  },

  isHuntingPage(): boolean {
    return document.querySelector(SELECTORS.DEFENDER.RUN_BUTTON) !== null;
  },

  runQuery(): RunOutcome {
    return triggerRun(document.querySelector<HTMLElement>(D.RUN_BUTTON));
  },

  readCellContext: readFluentCellContext,

  getOpenContextMenu: getOpenFluentContextMenu,

  menuOnClick: true,

  addContextMenuItem: addFluentMenuItem,

  closeContextMenu: closeFluentContextMenu,

  healthProbes,
};