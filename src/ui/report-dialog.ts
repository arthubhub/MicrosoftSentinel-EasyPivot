import { CSS_PREFIX } from '../config.ts';
import { copyText } from '../core/editor-bridge.ts';
import { log } from '../core/log.ts';
import { buildReport } from '../core/report.ts';
import { getSetting } from '../core/settings.ts';
import { t } from '../i18n/index.ts';
import { showToast } from './notification.ts';
import { P, el, button, downloadText } from './panel/shared.ts';

/**
 * Report dialog (N3, phase 5f): the only place a report is generated and the
 * only route it leaves the browser by (clipboard for Markdown, a local Blob
 * download for HTML - no network). Nothing is built until a button is clicked,
 * and every click builds a fresh report from what the case holds right then.
 *
 * MASKING: the checkbox starts from `settings.report.redact` (default on) and
 * is PER-REPORT state - it is never written back. Unticking it asks for a
 * confirmation; declining puts the tick back. The notice next to it says what
 * masking does NOT cover (notes are only pattern-masked).
 *
 * The client name is an explicit parameter from the case view (which already
 * shows it); `core/report.ts` never reads the client registry.
 */

const D = `${CSS_PREFIX}-report-dialog`;

export interface ReportDialogOptions {
  readonly caseId: string;
  /** Printed (masked by default) in the report's case header only */
  readonly clientName?: string;
  /** Display name of the case (`caseDisplayName`), printed as the report title instead of the stored name */
  readonly caseName?: string;
  /** Called after the dialog closed, e.g. to give focus back */
  readonly onClose?: () => void;
}

/** Opens the dialog; a second call while one is open just focuses the open one. */
export function openReportDialog(options: ReportDialogOptions): void {
  const existing = document.querySelector<HTMLElement>(`.${D}-overlay`);
  if (existing) {
    existing.querySelector<HTMLElement>('button')?.focus();
    return;
  }

  const overlay = el('div', `${D}-overlay`);
  // Same rule as the panels: clicks inside never reach the page's own handlers.
  overlay.addEventListener('mousedown', (e) => e.stopPropagation());
  const box = el('div', D);
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const titleId = `${D}-title`;
  box.setAttribute('aria-labelledby', titleId);

  const title = el('h2', `${D}-title`, t('reportDialog.title'));
  title.id = titleId;

  const redactBox = el('input', `${P}-ti-checkbox`);
  redactBox.type = 'checkbox';
  redactBox.checked = getSetting('report').redact !== false;
  const check = el('label', `${D}-check`);
  check.append(redactBox, document.createTextNode(t('reportDialog.redact')));

  const notice = el('p', `${D}-notice`);
  notice.setAttribute('role', 'note');
  const hint = el('p', `${D}-hint`, t('reportDialog.hint'));

  function paintNotice(): void {
    const masked = redactBox.checked;
    notice.textContent = masked ? t('report.notice.masked') : t('report.notice.clear');
    notice.classList.toggle(`${D}-notice--masked`, masked);
  }
  paintNotice();

  redactBox.addEventListener('change', () => {
    if (!redactBox.checked && !window.confirm(t('reportDialog.confirmClear'))) redactBox.checked = true;
    paintNotice();
  });

  function generate(): ReturnType<typeof buildReport> {
    const report = buildReport(options.caseId, {
      redact: redactBox.checked,
      ...(options.clientName ? { clientName: options.clientName } : {}),
      ...(options.caseName ? { caseName: options.caseName } : {}),
    });
    if (!report) showToast(t('notify.reportFailed'), 'error');
    return report;
  }

  const copyBtn = button(`${P}-btn ${P}-btn--primary`, t('reportDialog.copy'));
  copyBtn.addEventListener('click', () => {
    const report = generate();
    if (!report) return;
    void copyText(report.markdown).then((outcome) => {
      showToast(outcome === 'clipboard' ? t('notify.reportCopied') : t('notify.reportCopyDenied'), outcome === 'clipboard' ? 'success' : 'error');
    });
  });

  const downloadBtn = button(`${P}-btn`, t('reportDialog.download'));
  downloadBtn.addEventListener('click', () => {
    const report = generate();
    if (!report) return;
    try {
      downloadText(`easypivot-report-${Date.now()}.html`, report.html, 'text/html');
      showToast(t('notify.reportDownloaded'), 'success');
    } catch (err) {
      log.error('report-dialog: download failed', err);
      showToast(t('notify.reportFailed'), 'error');
    }
  });

  const closeBtn = button(`${P}-btn`, t('reportDialog.close'));
  const actions = el('div', `${D}-actions`);
  actions.append(copyBtn, downloadBtn, closeBtn);

  function close(): void {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    try {
      options.onClose?.();
    } catch (err) {
      log.error('report-dialog: onClose failed', err);
    }
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  }
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);

  box.append(title, check, notice, hint, actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  copyBtn.focus();
}
