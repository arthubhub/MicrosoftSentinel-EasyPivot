import type { MonacoEditorInstance, PlatformAdapter } from '../types.ts';
import { SELECTORS } from '../config.ts';
import { getMonacoEditorInstance } from '../core/editor-bridge.ts';
import {
  addFluentMenuItem,
  closeFluentContextMenu,
  getOpenFluentContextMenu,
  readFluentCellContext,
} from './fluent-grid.ts';

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
    return getMonacoEditorInstance();
  },

  isHuntingPage(): boolean {
    return document.querySelector(SELECTORS.DEFENDER.RUN_BUTTON) !== null;
  },

  readCellContext: readFluentCellContext,

  getOpenContextMenu: getOpenFluentContextMenu,

  menuOnClick: true,

  addContextMenuItem: addFluentMenuItem,

  closeContextMenu: closeFluentContextMenu,
};