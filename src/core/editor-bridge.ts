/* eslint-disable @typescript-eslint/no-explicit-any */
import { log } from './log.ts';

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

/**
 * Inject a KQL query into the Monaco editor.
 * Appends below existing content with \n\n separator.
 * Falls back to clipboard if editor not available. Always a Promise so a
 * clipboard rejection (permission denied, no focus, insecure context) can be
 * reported honestly instead of being assumed to succeed.
 */
export async function injectQuery(
  kql: string,
  queryName?: string,
): Promise<'injected' | 'clipboard' | 'failed'> {
  const payload = queryName ? `// ${queryName}\n${kql}` : kql;

  const editor = getActiveEditor();
  if (!editor) return copyText(payload);

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

  const model = editor.getModel?.();
  if (model && typeof model.pushEditOperations === 'function') {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  } else {
    editor.setValue(text);
  }
  editor.focus?.();
  return true;
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
