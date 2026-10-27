import { RECENT_RULES_MAX, STORAGE_KEYS } from '../config.ts';
import { getJson, setJson } from './storage.ts';

/**
 * Most-recently-launched rule ids (#17): newest first, capped at
 * `RECENT_RULES_MAX`, no duplicates. Pure storage access, no DOM.
 *
 * Stored as a flat `string[]` under `shq_recent_rules` — nothing else lives
 * under this key, and nothing else is expected to (phase 5's new settings
 * land under their own keys: `shq_clients`, `shq_cases`, …), so there is no
 * migration to plan for later: growing the list just means raising
 * `RECENT_RULES_MAX`.
 *
 * Callers (rules-view.ts) are responsible for resolving these ids through
 * `getRulesForIndicator()` before rendering, so a rule hidden by the
 * platform filter (#7) or removed from the catalog never reaches the UI —
 * this module only tracks ids, it never assumes the catalog still has them.
 */

export function listRecentRuleIds(): readonly string[] {
  const ids = getJson<string[]>(STORAGE_KEYS.RECENT_RULES, []);
  return Array.isArray(ids) ? ids : [];
}

/** Record a launched rule id as the most recent one (moves it to the front if already present). */
export function recordRecentRule(ruleId: string): void {
  const ids = [ruleId, ...listRecentRuleIds().filter((id) => id !== ruleId)].slice(0, RECENT_RULES_MAX);
  setJson(STORAGE_KEYS.RECENT_RULES, ids);
}
