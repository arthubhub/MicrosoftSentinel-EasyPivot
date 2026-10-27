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
