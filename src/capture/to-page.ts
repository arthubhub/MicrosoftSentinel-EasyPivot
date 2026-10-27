// ── toPage: hand a content-script function to page-world code (W1) ──
//
// `interceptor.ts` assigns its own functions onto objects the PAGE calls
// directly (`XMLHttpRequest.prototype.open/send/setRequestHeader`,
// `window.fetch`). On Firefox, with `@grant` != `none`, a function created
// in the content script carries content-script privilege; the page's own
// (unprivileged) code cannot call it directly across Firefox's Xray vision
// boundary - `exportFunction` is required to hand back a page-callable
// wrapper (the wrapped function still *runs* with its original privilege,
// it is only made *callable* by the page). Chrome/Tampermonkey's other
// supported engines have no such boundary: `exportFunction` is undefined
// there, so this is the identity function.
//
// `exportFunction` is declared as an optional ambient global in `types.ts`.

/* eslint-disable @typescript-eslint/no-explicit-any */

function pageWindow(): any {
  return typeof unsafeWindow !== 'undefined' ? unsafeWindow : typeof window !== 'undefined' ? window : undefined;
}

export function toPage<T extends (...args: any[]) => any>(fn: T): T {
  try {
    const w = pageWindow();
    const exporter: typeof exportFunction | undefined =
      (w && typeof w.exportFunction === 'function' ? w.exportFunction : undefined) ??
      (typeof exportFunction === 'function' ? exportFunction : undefined);
    if (w && typeof exporter === 'function') {
      return exporter(fn, w) as T;
    }
  } catch {
    // A failed export must never break the patch - fall back to the plain
    // function, which is exactly what every non-Firefox engine needs anyway.
  }
  return fn;
}
