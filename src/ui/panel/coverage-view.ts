import type { IndicatorId, PlatformId } from '../../types.ts';
import type { CapturedRowSet } from '../../capture/interceptor.ts';
import { CSS_PREFIX } from '../../config.ts';
import {
  buildCoverageIssue,
  findCoverageGaps,
  isDiscoveryResult,
  isReported,
  markReported,
  type CoverageGap,
} from '../../core/coverage.ts';
import { getIndicatorLabel } from '../../core/pivot.ts';
import { getCatalogStatus } from '../../core/rules-catalog.ts';
import { log } from '../../core/log.ts';
import { t } from '../../i18n/index.ts';
import { P, el, button } from './shared.ts';

/**
 * Coverage gaps of a discovery (`*-S9`) result (#33, N5). Shown only when the
 * last captured result is a discovery result. "Propose" shows the exact fields
 * that will be sent, then a link opens the prefilled GitHub form in a new tab:
 * nothing is sent by EasyPivot itself.
 */
export interface CoverageView {
  readonly root: HTMLDivElement;
  render(last: CapturedRowSet | null, type: IndicatorId, platform: PlatformId): void;
}

export function createCoverageView(): CoverageView {
  const root = el('div', `${P}-coverage`);
  root.hidden = true;
  let args: { last: CapturedRowSet | null; type: IndicatorId; platform: PlatformId } | null = null;
  let previewKey: string | null = null;

  function preview(gap: CoverageGap, type: IndicatorId, platform: PlatformId): HTMLElement {
    const box = el('div', `${P}-coverage-preview`);
    const issue = buildCoverageIssue(type, gap, platform, getCatalogStatus().version);
    if (!issue) {
      box.appendChild(el('div', `${P}-status ${P}-status--error`, t('coverage.unsafe')));
      return box;
    }
    box.appendChild(el('div', `${P}-coverage-title`, issue.title));
    const list = el('ul', `${P}-coverage-fields`);
    for (const [k, v] of issue.fields) if (v) list.appendChild(el('li', '', `${k} : ${v}`));
    box.appendChild(list);
    box.appendChild(el('div', `${P}-status`, t('coverage.previewHint')));
    const actions = el('div', `${P}-actions`);
    const link = el('a', `${P}-btn ${P}-btn--primary`, t('coverage.open'));
    link.href = issue.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.addEventListener('click', () => {
      markReported(type, gap);
      log.info('coverage: issue form opened', { type, platform }); // no table/column/value in logs
      previewKey = null;
      // Re-render after the browser has followed the link
      setTimeout(() => args && render(args.last, args.type, args.platform), 0);
    });
    const cancel = button(`${P}-btn`, t('coverage.cancel'));
    cancel.addEventListener('click', () => {
      previewKey = null;
      if (args) render(args.last, args.type, args.platform);
    });
    actions.append(link, cancel);
    box.appendChild(actions);
    return box;
  }

  function render(last: CapturedRowSet | null, type: IndicatorId, platform: PlatformId): void {
    args = { last, type, platform };
    root.replaceChildren();
    if (!last || !isDiscoveryResult(last.columns)) {
      root.hidden = true;
      return;
    }
    const gaps = findCoverageGaps(last.columns, last.rows).filter((g) => !isReported(type, g));
    root.hidden = false;
    root.appendChild(el('span', `${P}-field-label`, t('coverage.title', { n: gaps.length, type: getIndicatorLabel(type) })));
    if (gaps.length === 0) {
      root.appendChild(el('div', `${P}-status`, t('coverage.none')));
      return;
    }
    for (const gap of gaps) {
      const key = `${gap.table}|${gap.column}`;
      const row = el('div', `${P}-coverage-row`);
      const label = `${gap.table}.${gap.column}`;
      row.appendChild(el('code', `${P}-coverage-name`, label));
      row.appendChild(el('span', `${CSS_PREFIX}-badge`, gap.unread ? t('coverage.unread') : t('coverage.pathToCheck')));
      const propose = button(`${P}-btn`, t('coverage.propose'), t('coverage.proposeTitle'));
      propose.addEventListener('click', () => {
        previewKey = previewKey === key ? null : key;
        render(last, type, platform);
      });
      row.appendChild(propose);
      root.appendChild(row);
      if (previewKey === key) root.appendChild(preview(gap, type, platform));
    }
  }

  return { root, render };
}
