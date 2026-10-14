import type { ButtonAnchor, CellContext, MonacoEditorInstance, PlatformAdapter } from '../types.ts';
import { SELECTORS } from '../config.ts';
import { getMonacoEditorInstance } from '../core/editor-bridge.ts';

/**
 * MS Defender (security.microsoft.com) platform adapter.
 *
 * Key DOM landmark: #huntingRunQueryButtonId (Run query button). The EasyPivot
 * button is inserted right after Run's slot, whatever bar holds it: the page's
 * .scc-commandBar is not the hunting editor's bar (it does not contain Run),
 * and a button placed there was wiped on the next render.
 *
 * The results grid is not mapped yet: readCellContext returns null, so the
 * right-click keeps the browser menu. Once mapped, cellMenu 'none' makes the
 * right-click open the Pivot panel directly (Defender's grid has no menu).
 */
export const defenderAdapter: PlatformAdapter = {
  id: 'defender',
  label: 'Microsoft Defender',
  cellMenu: 'none',

  getButtonAnchor(): ButtonAnchor | null {
    const run = document.querySelector<HTMLElement>(SELECTORS.DEFENDER.RUN_BUTTON);
    if (!run) return null;
    const slot = run.closest<HTMLElement>(SELECTORS.DEFENDER.COMMAND_SLOT) ?? run;
    const container = slot.parentElement;
    return container ? { container, after: slot } : null;
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
