import { CSS_PREFIX } from '../../config.ts';

export const P = `${CSS_PREFIX}-pivot`;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, text: string, title?: string): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}

export function field(
  label: string,
  modifier: '' | 'wide' | 'grow',
  placeholder: string,
): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = el('label', `${P}-field${modifier ? ` ${P}-field--${modifier}` : ''}`);
  wrap.appendChild(el('span', `${P}-field-label`, label));
  const input = el('input', `${P}-input`);
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = placeholder;
  wrap.appendChild(input);
  return { wrap, input };
}

/** Local-only download, no network: Blob + an `<a download>` click (hard constraint: never any other route). */
export function downloadText(filename: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename: string, data: unknown): void {
  downloadText(filename, JSON.stringify(data, null, 2), 'application/json');
}
