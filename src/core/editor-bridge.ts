/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InsertMode, InsertOutcome, RunOutcome } from '../types.ts';
import { log } from './log.ts';
import { getSetting } from './settings.ts';

/**
 * Get the real page window - Tampermonkey sandboxes `window`, so we need
 * `unsafeWindow` to access the page's own globals like `window.monaco`.
 */
function getPageWindow(): any {
  if (typeof unsafeWindow !== 'undefined') return unsafeWindow;
  return window;
}

/**
 * Get the Monaco editor instance.
 * Uses: unsafeWindow.monaco.editor.getEditors()[0]
 */
export function getMonacoEditorInstance(): any | null {
  const w = getPageWindow();

  if (!w.monaco?.editor) return null;

  const getEditors = w.monaco.editor.getEditors;
  if (typeof getEditors !== 'function') return null;

  const editors = getEditors.call(w.monaco.editor);
  if (!editors || editors.length === 0) return null;

  const ed = editors[0];
  if (typeof ed.getValue !== 'function' || typeof ed.setValue !== 'function') return null;

  return ed;
}

/**
 * Number of registered Monaco editor instances (health diagnostic, N6
 * editor probe: a count only, not `getActiveEditor()` - that is 1f).
 */
export function getMonacoEditorCount(): number {
  const w = getPageWindow();
  const getEditors = w.monaco?.editor?.getEditors;
  if (typeof getEditors !== 'function') return 0;
  const editors = getEditors.call(w.monaco.editor);
  return Array.isArray(editors) ? editors.length : 0;
}

// ── Active editor resolution (#13) ──
// Step-0 survey: one Monaco editor shared by every tab on both platforms, so
// this chain almost always lands on step 1 or step 4 with a single editor.
// Implemented in full anyway - cheap, and the survey was one tenant/one day.

/** Same validity check `getMonacoEditorInstance` has always used. */
function isValidEditor(ed: any): boolean {
  return !!ed && typeof ed.getValue === 'function' && typeof ed.setValue === 'function';
}

/** `getDomNode()?.offsetParent !== null`, defensive against a missing method. */
function isVisibleEditor(ed: any): boolean {
  if (typeof ed.getDomNode !== 'function') return false;
  try {
    return ed.getDomNode()?.offsetParent !== null;
  } catch {
    return false;
  }
}

/** Editors already wired to focus tracking, with their disposer. */
const focusSubscriptions = new Map<any, () => void>();

/** Last editor seen to gain text focus, kept across calls (and SPA tab swaps). */
let lastFocusedEditor: any | null = null;

/**
 * Subscribe once to `onDidFocusEditorText` so we can fall back to "last
 * focused" when nothing has focus right now. Never throws: a missing or
 * misbehaving API just means we lose that one signal, not the whole
 * resolution. The subscription itself never leaks a non-function disposable.
 */
function trackFocus(ed: any): void {
  if (focusSubscriptions.has(ed)) return;
  if (typeof ed.onDidFocusEditorText !== 'function') return;

  try {
    const disposable = ed.onDidFocusEditorText.call(ed, () => {
      lastFocusedEditor = ed;
    });
    const dispose =
      disposable && typeof disposable.dispose === 'function'
        ? () => disposable.dispose()
        : () => {};
    focusSubscriptions.set(ed, dispose);
  } catch {
    // Subscribing failed - nothing to track, nothing to clean up either
  }
}

/**
 * Resolve the editor the user is actually working in, in order (plan W2
 * step 6, issue #13): focused now -> last focused -> visible -> first.
 * Returns null if Monaco, `getEditors`, or any valid editor is missing.
 */
export function getActiveEditor(): any | null {
  const w = getPageWindow();
  if (!w.monaco?.editor) return null;

  const getEditors = w.monaco.editor.getEditors;
  if (typeof getEditors !== 'function') return null;

  let editors: unknown;
  try {
    editors = getEditors.call(w.monaco.editor);
  } catch {
    return null;
  }
  if (!Array.isArray(editors) || editors.length === 0) return null;

  const valid = editors.filter(isValidEditor);
  if (valid.length === 0) return null;

  // Attach focus tracking lazily - cheap, and keeps `lastFocusedEditor` fresh
  for (const ed of valid) trackFocus(ed);

  // 1. currently has text focus
  for (const ed of valid) {
    if (typeof ed.hasTextFocus !== 'function') continue;
    try {
      if (ed.hasTextFocus()) { log.debug(`editor: resolved by focus (${valid.length} editor(s))`); return ed; }
    } catch {
      // keep checking the rest
    }
  }

  // 2. last editor that gained text focus, if it is still one of today's editors
  if (lastFocusedEditor && valid.includes(lastFocusedEditor)) {
    log.debug('editor: resolved by last focus');
    return lastFocusedEditor;
  }

  // 3. first visible editor
  const visible = valid.find(isVisibleEditor);
  if (visible) return visible;

  // 4. first editor
  return valid[0];
}

/**
 * Drop all `onDidFocusEditorText` subscriptions and forget the last-focused
 * editor. Call this from `main.ts`'s `removeUI()` so SPA navigation away
 * from the hunting page doesn't leak disposables across editor instances.
 */
export function teardownActiveEditorTracking(): void {
  for (const dispose of focusSubscriptions.values()) {
    try {
      dispose();
    } catch {
      // disposer itself misbehaving - nothing more we can do
    }
  }
  focusSubscriptions.clear();
  lastFocusedEditor = null;
}

// ── Insert strategies (W2 step 6, #22) ──
// Both helpers assume `editor` is already a validated, resolved instance
// (`getActiveEditor()`'s job) - they only decide HOW to put text into it.

/** `append`: existing behaviour, byte-identical - current content + \n\n + payload, via `setValue`. */
function applyAppend(editor: any, payload: string): void {
  const currentValue: string = editor.getValue();
  const newValue =
    currentValue.trim().length > 0 ? currentValue + '\n\n' + payload : payload;

  editor.setValue(newValue);

  const model = editor.getModel?.();
  if (model) {
    const lineCount = model.getLineCount();
    const lastLine = model.getLineContent(lineCount);
    const pos = { lineNumber: lineCount, column: lastLine.length + 1 };
    editor.setPosition?.(pos);
    editor.revealPositionInCenter?.(pos);
  }

  editor.focus?.();
}

/** `replace`: through the model's edit stack when possible, so Ctrl+Z works. */
function applyReplace(editor: any, text: string): void {
  const model = editor.getModel?.();
  if (model && typeof model.pushEditOperations === 'function') {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  } else {
    editor.setValue(text);
  }
  editor.focus?.();
}

/**
 * Inject a KQL query into the Monaco editor (W2 step 6, #22). `mode`
 * (default `append`, the only path exercised before 4f - kept byte-identical):
 *  - `append`: adds `payload` below existing content with a `\n\n` separator.
 *  - `replace`: via `applyReplace` (model edit stack), so Ctrl+Z restores the
 *    previous content - same path `replaceEditorContent()` below uses.
 *  - `newTab`: NOT implementable. The step-0 survey found a SINGLE Monaco
 *    editor shared by every tab on both platforms (switching tab swaps the
 *    model, not the instance) - there is no "open a new tab" call the editor
 *    API exposes. Falls back to `append` and reports `'newTabUnsupported'`
 *    rather than claiming `'injected'`: a mode that silently behaves like
 *    `append` while claiming to work would be worse than an honest failure.
 * Falls back to clipboard if no editor is available at all (any mode).
 * Always a Promise so a clipboard rejection (permission denied, no focus,
 * insecure context) can be reported honestly instead of being assumed to
 * succeed (#4).
 */
export async function injectQuery(
  kql: string,
  mode: InsertMode = 'append',
  queryName?: string,
): Promise<InsertOutcome> {
  const payload = queryName ? `// ${queryName}\n${kql}` : kql;

  const editor = getActiveEditor();
  if (!editor) {
    log.debug(`editor-bridge: injectQuery(mode=${mode}) - no editor, falling back to clipboard`);
    return copyText(payload);
  }

  if (mode === 'replace') {
    applyReplace(editor, payload);
    log.info('editor-bridge: injectQuery - replaced editor content (mode=replace)');
    return 'injected';
  }

  // `append` and the degraded `newTab` both land here.
  applyAppend(editor, payload);
  if (mode === 'newTab') {
    log.warn(
      'editor-bridge: injectQuery - mode=newTab is not implementable (single Monaco editor shared by every tab), appended instead',
    );
    return 'newTabUnsupported';
  }
  log.info('editor-bridge: injectQuery - appended to editor content (mode=append)');
  return 'injected';
}

/** Current editor content, or null if the editor is not available. */
export function getEditorText(): string | null {
  const editor = getActiveEditor();
  if (!editor) return null;
  const value: unknown = editor.getValue();
  return typeof value === 'string' ? value : null;
}

/**
 * Replace the whole editor content. Goes through the model's edit stack when
 * possible so Ctrl+Z brings the previous content back.
 */
export function replaceEditorContent(text: string): boolean {
  const editor = getActiveEditor();
  if (!editor) return false;
  applyReplace(editor, text);
  return true;
}

// ── Run (N1 level 2 "Insérer + Run", #22) ──

/**
 * Click the Run button if present, else dispatch Shift+Enter to the active
 * editor as a fallback (step-0 survey: "clic par script vérifié ; raccourci
 * Maj+Entrée" on both platforms). `button` is resolved by the platform
 * adapter from its own selector (DOM selectors stay in `platforms/*`, see
 * CLAUDE.md) - this function only decides HOW to trigger it, generically.
 *
 * Gated on the `autoRun` setting IN HERE, not only by the caller: project
 * rule 4 ("pas de requête dans le dos de l'utilisateur") must hold even if
 * some future caller forgets to check the setting itself.
 */
export function runQuery(button: HTMLElement | null): RunOutcome {
  if (!getSetting('autoRun')) {
    log.debug('editor-bridge: runQuery - autoRun is off, no-op');
    return 'disabled';
  }

  if (button) {
    button.click();
    log.info('editor-bridge: runQuery - Run button clicked');
    return 'clicked';
  }

  const editor = getActiveEditor();
  const domNode = typeof editor?.getDomNode === 'function' ? editor.getDomNode() : null;
  if (!domNode) {
    log.warn('editor-bridge: runQuery - Run button missing and no editor to send Shift+Enter to');
    return 'unavailable';
  }

  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  domNode.dispatchEvent(event);
  log.info('editor-bridge: runQuery - Run button missing, dispatched Shift+Enter fallback to the editor');
  return 'fallback';
}

/** Generic clipboard write, also used by the "Copy diagnostics" action (N6) */
export async function copyText(text: string): Promise<'clipboard' | 'failed'> {
  // Absent in older browsers, and in insecure (non-HTTPS) contexts
  if (!navigator.clipboard?.writeText) return 'failed';

  try {
    await navigator.clipboard.writeText(text);
    return 'clipboard';
  } catch {
    // Permission denied, page not focused, etc. - never left unhandled
    return 'failed';
  }
}
