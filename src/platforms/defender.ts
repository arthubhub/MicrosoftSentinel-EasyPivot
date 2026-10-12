import type { CellContext, MonacoEditorInstance, PlatformAdapter } from '../types.ts';
import { SELECTORS } from '../config.ts';
import { getMonacoEditorInstance } from '../core/editor-bridge.ts';

/**
 * MS Defender (security.microsoft.com) platform adapter.
 *
 * Key DOM landmarks:
 * - .scc-sidePanelPage-mainContent                - main content area
 * - .scc-commandBar                               - top command bar wrapper
 * - .scc-commandBar .ms-CommandBar-primaryCommand  - primary commands (Run, time, Save, Share)
 * - #huntingRunQueryButtonId                       - Run query button
 *
 * NOTE: There are multiple .ms-CommandBar-primaryCommand on the page
 * (top bar + results table bar). The selector is scoped to .scc-commandBar
 * to target only the top one.
 *
 * The results grid is not mapped yet: readCellContext returns null, so the
 * right-click keeps the browser menu. Once mapped, cellMenu 'none' makes the
 * right-click open the Pivot panel directly (Defender's grid has no menu).
 */
export const defenderAdapter: PlatformAdapter = {
  id: 'defender',
  label: 'Microsoft Defender',
  cellMenu: 'none',

  getButtonInjectionTarget(): HTMLElement | null {
    // There are multiple .scc-commandBar on the page (top bar + results table bar).
    // Scope to the FIRST one inside mainContent - that's the top command bar.
    const mainContent = document.querySelector<HTMLElement>(SELECTORS.DEFENDER.MAIN_CONTENT);
    if (!mainContent) return null;
    const topCommandBar = mainContent.querySelector<HTMLElement>(SELECTORS.DEFENDER.COMMAND_BAR);
    if (!topCommandBar) return null;
    return topCommandBar.querySelector<HTMLElement>('.ms-CommandBar-primaryCommand');
  },

  getMonacoEditor(): MonacoEditorInstance | null {
    return getMonacoEditorInstance();
  },

  isHuntingPage(): boolean {
    return document.querySelector(SELECTORS.DEFENDER.RUN_BUTTON) !== null;
  },

  readCellContext(): CellContext | null {
    return null;
  },

  getOpenContextMenu(): HTMLElement | null {
    return null;
  },
};
