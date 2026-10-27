import type { IndicatorId, PivotRule, PivotSnapshot, PlatformVariant } from '../../types.ts';
import { CSS_PREFIX } from '../../config.ts';
import { ACTION_IDS, getActionLabel, getRulesForIndicator } from '../../core/pivot.ts';
import { t } from '../../i18n/index.ts';
import { P, el, button } from './shared.ts';

const CHEVRON_SVG =
  '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
  '<path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

export interface RulesView {
  readonly root: HTMLDivElement;
  renderRules(
    selected: IndicatorId,
    expanded: Set<string>,
    snapshot: PivotSnapshot | undefined,
    value: string,
    variant: PlatformVariant,
    onRuleClick: (rule: PivotRule) => void,
  ): void;
}

export function createRulesView(): RulesView {
  // Rules
  const list = el('div', `${P}-list`);

  function ruleMeta(rule: PivotRule): string {
    const parts = [rule.id, `−${rule.window.before} / +${rule.window.after}`];
    if (rule.render && rule.render !== 'table') parts.push(rule.render);
    return parts.join(' · ');
  }

  function renderRule(
    rule: PivotRule,
    ran: ReadonlySet<string>,
    expanded: Set<string>,
    onRuleClick: (rule: PivotRule) => void,
  ): HTMLElement {
    const item = el('div', `${P}-rule`);

    const rowEl = el('div', `${P}-rule-row`);
    rowEl.title = t('panel.rules.injectTitle');
    const body = el('div', `${P}-rule-body`);
    const name = el('div', `${P}-rule-name`);
    name.appendChild(el('span', '', rule.name));
    if (rule.v1) name.appendChild(el('span', `${CSS_PREFIX}-badge ${CSS_PREFIX}-badge--source`, 'v1'));
    if (ran.has(rule.id)) {
      const badge = el('span', `${CSS_PREFIX}-badge ${P}-badge--ran`, t('panel.rules.ranBadge'));
      badge.title = t('panel.rules.ranTitle');
      name.appendChild(badge);
    }
    body.append(name, el('div', `${P}-rule-meta`, ruleMeta(rule)));

    const chevron = button(`${CSS_PREFIX}-icon-btn ${CSS_PREFIX}-icon-btn--chevron`, '', t('panel.rules.detailsTitle'));
    chevron.innerHTML = CHEVRON_SVG;

    const details = el('div', `${P}-rule-details`);
    details.appendChild(el('p', `${P}-rule-desc`, rule.description));
    const reading: [keyof NonNullable<PivotRule['reading']>, string][] = [
      ['decisive', t('panel.rules.readingDecisive')],
      ['context', t('panel.rules.readingContext')],
      ['noise', t('panel.rules.readingNoise')],
    ];
    for (const [key, label] of reading) {
      const text = rule.reading?.[key];
      if (!text) continue;
      const line = el('div', `${P}-reading ${P}-reading--${key}`);
      line.append(el('strong', '', label), document.createTextNode(text));
      details.appendChild(line);
    }

    const setOpen = (open: boolean): void => {
      details.hidden = !open;
      chevron.classList.toggle(`${CSS_PREFIX}-icon-btn--chevron-open`, open);
    };
    setOpen(expanded.has(rule.id));

    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      if (expanded.has(rule.id)) expanded.delete(rule.id);
      else expanded.add(rule.id);
      setOpen(expanded.has(rule.id));
    });
    rowEl.addEventListener('click', () => onRuleClick(rule));

    rowEl.append(body, chevron);
    item.append(rowEl, details);
    return item;
  }

  function renderRules(
    selected: IndicatorId,
    expanded: Set<string>,
    snapshot: PivotSnapshot | undefined,
    value: string,
    variant: PlatformVariant,
    onRuleClick: (rule: PivotRule) => void,
  ): void {
    list.replaceChildren();
    // #7: rules whose `platforms` excludes the current variant are hidden,
    // not greyed (cheaper, and avoids a confusing clickable-but-dead entry);
    // the count below makes the hiding visible instead of silent.
    const rules = getRulesForIndicator(selected, variant);
    const hiddenCount = getRulesForIndicator(selected).length - rules.length;

    if (rules.length === 0) {
      list.appendChild(el('div', `${CSS_PREFIX}-empty`, t('panel.rules.noRules')));
    } else {
      const ran = new Set(
        (snapshot?.steps ?? []).filter((s) => s.value === value).map((s) => s.ruleId),
      );

      for (const action of ACTION_IDS) {
        const group = rules.filter((r) => r.action === action);
        if (group.length === 0) continue;
        const section = el('div', `${P}-section`);
        section.appendChild(
          el('div', `${P}-section-title ${P}-section-title--${action}`, getActionLabel(action)),
        );
        for (const rule of group) section.appendChild(renderRule(rule, ran, expanded, onRuleClick));
        list.appendChild(section);
      }
    }

    if (hiddenCount > 0) {
      list.appendChild(
        el(
          'div',
          `${CSS_PREFIX}-empty`,
          t('panel.rules.hiddenForPlatform', { n: hiddenCount, s: hiddenCount > 1 ? 's' : '' }),
        ),
      );
    }
  }

  return { root: list, renderRules };
}
