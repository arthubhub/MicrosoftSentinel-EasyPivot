import { CSS_PREFIX } from '../config.ts';
import { buttonStyles } from './button.css.ts';
import { popupStyles } from './popup.css.ts';
import { notificationStyles } from './notification.css.ts';
import { pivotStyles } from './pivot.css.ts';
import { caseViewStyles } from './case-view.css.ts';
import { reportDialogStyles } from './report-dialog.css.ts';

let injected = false;

/** Inject all userscript styles into the document head */
export function injectStyles(): void {
  if (injected) return;
  injected = true;

  const style = document.createElement('style');
  style.id = `${CSS_PREFIX}-styles`;
  // pivotStyles relies on popupStyles (chips, badges, animation): keep both
  style.textContent = [
    buttonStyles,
    popupStyles,
    notificationStyles,
    pivotStyles,
    caseViewStyles,
    reportDialogStyles,
  ].join('\n');
  document.head.appendChild(style);
}
