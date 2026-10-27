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
    recentRuleIds: readonly string[],
    onRuleClick: (rule: PivotRule) => void,
  ): void;
  /** Clear the search box and scroll back to the top (panel re-open) */
  resetView(): void;
}

/** Case/accent-insensitive fold for the search box only (#17) — "Activité" must be findable by "activite" */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function matchesSearch(rule: PivotRule, needle: string): boolean {
  if (!needle) return true;
  return fold(`${rule.id} ${rule.name} ${rule.description}`).includes(needle);
}

export function createRulesView(): RulesView {
  const root = el('div', `${P}-rules`);

  // ── Search box (#17) ──
  const searchWrap = el('div', `${P}-search-wrap`);
  const searchInput = el('input', `${P}-input ${P}-search`);
  searchInput.type = 'search';
  searchInput.spellcheck = false;
  searchInput.autocomplete = 'off';
  searchInput.placeholder = t('panel.rules.searchPlaceholder');
  searchInput.title = t('panel.rules.searchTitle');
  searchWrap.appendChild(searchInput);

  // Rules (the only scrolling area, nested under `root` so the search box stays put)
  const list = el('div', `${P}-list`);
  root.append(searchWrap, list);

  // ── Keyboard navigation state (#17) ──
  let highlightIndex = -1;
  let flatRules: PivotRule[] = [];
  let rowEls: HTMLElement[] = [];
  let lastArgs: {
    selected: IndicatorId;
    expanded: Set<string>;
    snapshot: PivotSnapshot | undefined;
    value: string;
    variant: PlatformVariant;
    recentRuleIds: readonly string[];
    onRuleClick: (rule: PivotRule) => void;
  } | null = null;

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
  ): { item: HTMLElement; rowEl: HTMLElement } {
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
    return { item, rowEl };
  }

  function applyHighlight(): void {
    rowEls.forEach((rowEl, i) => {
      rowEl.classList.toggle(`${P}-rule-row--highlight`, i === highlightIndex);
    });
    if (highlightIndex >= 0) rowEls[highlightIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function render(): void {
    if (!lastArgs) return;
    const { selected, expanded, snapshot, value, variant, recentRuleIds, onRuleClick } = lastArgs;
    list.replaceChildren();

    // #7: rules whose `platforms` excludes the current variant are hidden,
    // not greyed (cheaper, and avoids a confusing clickable-but-dead entry);
    // the count below makes the hiding visible instead of silent.
    const eligible = getRulesForIndicator(selected, variant);
    const hiddenCount = getRulesForIndicator(selected).length - eligible.length;

    const needle = fold(searchInput.value.trim());
    const filtered = needle ? eligible.filter((r) => matchesSearch(r, needle)) : eligible;

    flatRules = [];
    rowEls = [];

    if (eligible.length === 0) {
      list.appendChild(el('div', `${CSS_PREFIX}-empty`, t('panel.rules.noRules')));
    } else if (filtered.length === 0) {
      list.appendChild(el('div', `${CSS_PREFIX}-empty`, t('panel.rules.noSearchMatch')));
    } else {
      const ran = new Set(
        (snapshot?.steps ?? []).filter((s) => s.value === value).map((s) => s.ruleId),
      );

      // Recent rules (#17): most-recent-first, resolved against `filtered`
      // only — a rule hidden by the platform filter or removed from the
      // catalog simply has no match here and is skipped silently, no
      // special case needed.
      const recentSeen = new Set<string>();
      const recentRules: PivotRule[] = [];
      for (const id of recentRuleIds) {
        if (recentSeen.has(id)) continue;
        const rule = filtered.find((r) => r.id === id);
        if (rule) {
          recentRules.push(rule);
          recentSeen.add(id);
        }
      }

      if (recentRules.length > 0) {
        const section = el('div', `${P}-section`);
        section.appendChild(
          el('div', `${P}-section-title ${P}-section-title--recent`, t('panel.rules.recentTitle')),
        );
        for (const rule of recentRules) {
          const { item, rowEl } = renderRule(rule, ran, expanded, onRuleClick);
          section.appendChild(item);
          flatRules.push(rule);
          rowEls.push(rowEl);
        }
        list.appendChild(section);
      }

      for (const action of ACTION_IDS) {
        const group = filtered.filter((r) => r.action === action && !recentSeen.has(r.id));
        if (group.length === 0) continue;
        const section = el('div', `${P}-section`);
        section.appendChild(
          el('div', `${P}-section-title ${P}-section-title--${action}`, getActionLabel(action)),
        );
        for (const rule of group) {
          const { item, rowEl } = renderRule(rule, ran, expanded, onRuleClick);
          section.appendChild(item);
          flatRules.push(rule);
          rowEls.push(rowEl);
        }
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

    if (highlightIndex >= flatRules.length) highlightIndex = flatRules.length - 1;
    applyHighlight();
  }

  function renderRules(
    selected: IndicatorId,
    expanded: Set<string>,
    snapshot: PivotSnapshot | undefined,
    value: string,
    variant: PlatformVariant,
    recentRuleIds: readonly string[],
    onRuleClick: (rule: PivotRule) => void,
  ): void {
    lastArgs = { selected, expanded, snapshot, value, variant, recentRuleIds, onRuleClick };
    render();
  }

  // ── Search + keyboard navigation (#17) ──
  // Escape is intentionally NOT handled here: pivot-menu.ts registers a
  // single document-level listener (capture phase) that closes the panel;
  // capture runs before this element's own (bubble-phase) listener would
  // ever see the key, so a second Escape handler here would be dead code.
  searchInput.addEventListener('input', () => {
    highlightIndex = -1;
    render();
  });

  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      if (flatRules.length === 0) return;
      e.preventDefault();
      highlightIndex = highlightIndex < 0 ? 0 : Math.min(highlightIndex + 1, flatRules.length - 1);
      applyHighlight();
    } else if (e.key === 'ArrowUp') {
      if (flatRules.length === 0) return;
      e.preventDefault();
      highlightIndex = highlightIndex <= 0 ? 0 : highlightIndex - 1;
      applyHighlight();
    } else if (e.key === 'Enter') {
      if (highlightIndex < 0 || !flatRules[highlightIndex] || !lastArgs) return;
      e.preventDefault();
      lastArgs.onRuleClick(flatRules[highlightIndex]);
    }
  });

  function resetView(): void {
    searchInput.value = '';
    highlightIndex = -1;
    render();
    list.scrollTop = 0;
  }

  return { root, renderRules, resetView };
}
