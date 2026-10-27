import type { Case } from '../types.ts';
import { systemKindOf } from '../core/cases.ts';
import { t } from '../i18n/index.ts';

/**
 * The ONE place a case's name is turned into what the user reads (project
 * rule 6). `Case.name` is stored data: the system cases EasyPivot provisions
 * ("Non attribué", "Historique avant cas") are stored in French and must stay
 * so (rule 8 - older data is never rewritten), so every UI surface that shows a
 * case name goes through here and gets the label in the current language.
 *
 * Ordinary cases (typed by the user) are returned as stored. Exports keep the
 * STORED name on purpose: a file is a record, not a view - it must say the
 * same thing whichever language the exporting browser happened to use.
 */
export function caseDisplayName(c: Pick<Case, 'name' | 'tenantKeys' | 'system'>): string {
  const kind = systemKindOf(c);
  if (kind === 'unassigned') return t('case.system.unassigned');
  if (kind === 'migration') return t('case.system.migration');
  return c.name;
}
