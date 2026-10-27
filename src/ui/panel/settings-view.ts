import type { Client, IndicatorId, TenantKey } from '../../types.ts';
import { CASES, CSS_PREFIX, DEFAULT_RULES_URL } from '../../config.ts';
import { getCatalogStatus } from '../../core/rules-catalog.ts';
import { getIndicatorIds, getIndicatorLabel } from '../../core/pivot.ts';
import { BUILTIN_TI_PROVIDERS, isValidTiTemplate, type TiProvider } from '../../core/ti-links.ts';
import { getSetting, setSetting } from '../../core/settings.ts';
import {
  addClient,
  buildClientKeyIndex,
  deleteClient,
  findClientByKey,
  getClients,
  type ClientMutationResult,
} from '../../core/clients.ts';
import {
  archiveCase,
  deleteArchivedCases,
  deleteCase,
  getCase,
  getCaseIndexEntries,
  getCaseStats,
  listAllCasesInScope,
  listCasesInScope,
  type CaseIndexEntry,
} from '../../core/cases.ts';
import {
  buildCaseExport,
  importCase,
  importCaseAcceptingForeignKeys,
  parseCaseExport,
  type CaseImportRefusalCode,
  type CaseImportScope,
} from '../../core/case-export.ts';
import {
  buildClientsExport,
  importClients,
  parseClientsExport,
  type ClientsImportRefusalCode,
} from '../../core/clients-export.ts';
import { extractDefenderTidFromSearch, extractSentinelResourceIdFromHash } from '../../core/tenant.ts';
import { countAllCaptureData, deleteAllCaptureData, estimateStoreBytes, getKnownTenantKeys, purgeNow } from '../../capture/store.ts';
import { clearLastCapture } from '../../capture/interceptor.ts';
import {
  buildMigrationExport,
  deleteOldHistory,
  getMigrationConfirmedAt,
  hasOldHistory,
  hasOldSnapshots,
} from '../../core/migration.ts';
import { log } from '../../core/log.ts';
import { t } from '../../i18n/index.ts';
import { caseDisplayName } from '../case-name.ts';
import { showToast } from '../notification.ts';
import { P, el, button, field, downloadJson } from './shared.ts';

/** Display name of a just-imported case (system cases translated); the stored name if it cannot be read back. */
function importedCaseLabel(caseId: string, storedName: string): string {
  const c = getCase(caseId);
  return c ? caseDisplayName(c) : storedName;
}

function relativeAge(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return t('settings.ageNow');
  if (min < 60) return t('settings.ageMinutes', { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t('settings.ageHours', { n: h });
  return t('settings.ageDays', { n: Math.round(h / 24) });
}

export interface SettingsView {
  readonly root: HTMLDivElement;
  readonly urlField: { wrap: HTMLLabelElement; input: HTMLInputElement };
  readonly saveUrlBtn: HTMLButtonElement;
  readonly defaultUrlBtn: HTMLButtonElement;
  readonly catalogStatus: HTMLDivElement;
  readonly catalogError: HTMLDivElement;
  readonly catalogWarnings: HTMLDivElement;
  renderStatus(): void;
  /** Rebuilds the provider checkboxes and custom-provider list from current settings. */
  renderTi(): void;
  /** Rebuilds the client list from `core/clients.ts` (N2, phase 5a). */
  renderClients(): void;
  /** Refreshes the migration status line and which of the two buttons are shown (N2, phase 5c). */
  renderMigration(): void;
  /**
   * Repaints the case export/import block AND the Cases management list (both
   * depend on the same async tenant scope) and, if that scope is not known
   * yet, kicks off its (async) resolution (N2, phases 5d / retention).
   */
  renderCaseTransfer(): void;
}

export interface SettingsViewOptions {
  /**
   * Lets the caller refresh anything else that depends on
   * `ti.providers`/`ti.custom` (the links shown under the Value field in
   * `params-view.ts`) right when a checkbox is toggled here, instead of
   * waiting for the panel to be reopened.
   */
  readonly onTiChange?: () => void;
  /**
   * The tenant key the case bar resolved (`ui/case-bar.ts`'s
   * `getCurrentKey()`), or `undefined` while it is still resolving. The
   * case export/import block needs it to know which cases are in scope and
   * to validate an imported case's keys; with no key it disables itself
   * rather than guessing (N2 "Cloisonnement").
   */
  readonly getCurrentKey?: () => TenantKey | undefined;
  /** Called after an import changed the case list, so the case bar can re-resolve. */
  readonly onCasesChanged?: () => void;
}

/** Splits a textarea's content on newlines or commas, trims, drops empties. */
function splitMultiValue(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Translates an `addClient` failure into a user-facing message. `core/clients.ts`
 * stays i18n-free (DOM-free convention) and returns typed reason codes instead -
 * this is the one place that turns those codes into text, mirroring how
 * `core/health.ts` maps `ProbeState` to a label.
 */
function clientMutationErrorMessage(result: Extract<ClientMutationResult, { ok: false }>): string {
  if (result.field === 'tid') {
    return result.reason === 'duplicate'
      ? t('settings.clients.error.tidDuplicate', { value: result.value ?? '' })
      : t('settings.clients.error.tidInvalid', { value: result.value ?? '' });
  }
  if (result.field === 'workspace') {
    return result.reason === 'duplicate'
      ? t('settings.clients.error.workspaceDuplicate', { value: result.value ?? '' })
      : t('settings.clients.error.workspaceInvalid', { value: result.value ?? '' });
  }
  return t('settings.clients.error.emptyName');
}

/** Generated client-side only, never sent anywhere: just a stable key for `ti.providers`. */
function newCustomId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turns an import refusal code into text. `core/case-export.ts` and
 * `core/clients-export.ts` stay i18n-free (DOM-free convention) and return
 * typed codes; this is the one place that maps them, same precedent as
 * `clientMutationErrorMessage` above. Grouped on purpose - the user needs
 * to know what to do next ("wrong file", "unreadable", "too big"), not
 * which field failed.
 */
function importRefusalMessage(code: CaseImportRefusalCode | ClientsImportRefusalCode): string {
  switch (code) {
    case 'too-large':
      return t('settings.import.tooLarge');
    case 'empty':
    case 'not-json':
    case 'not-an-object':
      return t('settings.import.notJson');
    case 'wrong-format':
    case 'unsupported-version':
      return t('settings.import.wrongFormat');
    default:
      return t('settings.import.invalidContent');
  }
}

export function createSettingsView(options?: SettingsViewOptions): SettingsView {
  const onTiChange = options?.onTiChange;
  // Settings
  const settings = el('div', `${P}-settings`);
  settings.hidden = true;
  const urlField = field(t('settings.rulesUrlLabel'), 'wide', DEFAULT_RULES_URL);
  const settingsActions = el('div', `${P}-actions`);
  const saveUrlBtn = button(`${P}-btn ${P}-btn--primary`, t('settings.saveReload'));
  const defaultUrlBtn = button(`${P}-btn`, t('settings.defaultUrl'));
  settingsActions.append(saveUrlBtn, defaultUrlBtn);
  const catalogStatus = el('div', `${P}-status`);
  const catalogError = el('div', `${P}-status ${P}-status--error`);
  const catalogWarnings = el('div', `${P}-status`);

  // ── Capture storage (N1 "Bouton « Purger maintenant » et indicateur de
  // taille"). Scoped to "everything" (`estimateStoreBytes('all')`): the
  // active tenant key is resolved asynchronously elsewhere (core/tenant.ts)
  // and not available synchronously here - per-tenant purge stays available
  // from `capture/store.ts`'s own API for a future, more granular UI
  // (phase 5, once a case bar exists to say which tenant is "current"). The
  // logic (what to drop, in what order) lives entirely in store.ts; this is
  // only a button + a status line. ──
  // ── capture.sanitizeValues: the opt-in mitigation for N1 keeping
  // summary.topValues (real customer values) for retention.days even when the
  // row sample is dropped. Masking happens at STORE time in capture/store.ts,
  // so toggling this affects runs captured from now on, not ones already
  // stored - said so in the hint text rather than implying a retroactive wipe. ──
  const sanitizeRow = el('div', `${P}-ti-provider-row`);
  const sanitizeBox = el('input', `${P}-ti-checkbox`);
  sanitizeBox.type = 'checkbox';
  sanitizeBox.checked = getSetting('capture').sanitizeValues;
  sanitizeBox.addEventListener('change', () => {
    const capture = getSetting('capture');
    setSetting('capture', { ...capture, sanitizeValues: sanitizeBox.checked });
    log.debug('capture: sanitizeValues toggled', { enabled: sanitizeBox.checked });
    renderPurgeStatus();
  });
  const sanitizeLabel = el('label', `${P}-ti-provider-label`);
  sanitizeLabel.append(sanitizeBox, document.createTextNode(t('settings.sanitize.label')));
  sanitizeRow.appendChild(sanitizeLabel);
  const sanitizeHint = el('div', `${P}-status`, t('settings.sanitize.hint'));

  const purgeTitle = el('span', `${P}-field-label`, t('settings.purge.title'));
  const purgeStatus = el('div', `${P}-status`);
  const purgeBtn = button(`${P}-btn`, t('settings.purge.button'));
  const purgeRow = el('div', `${P}-actions`);
  purgeRow.append(purgeBtn);

  function renderPurgeStatus(): void {
    const mb = estimateStoreBytes('all') / 1_000_000;
    purgeStatus.textContent = t('settings.purge.size', { mb: mb.toFixed(2) });
  }
  renderPurgeStatus();

  purgeBtn.addEventListener('click', () => {
    try {
      const report = purgeNow('all');
      log.debug('capture/store: manual purge from settings', report);
      const mb = estimateStoreBytes('all') / 1_000_000;
      purgeStatus.textContent = t('settings.purge.done', {
        samples: report.samplesDroppedByAge + report.samplesDroppedByClosedCase + report.samplesDroppedByBytes,
        runs: report.runsDroppedByBytes,
        mb: mb.toFixed(2),
      });
    } catch (err) {
      log.error('settings: purge now failed', err);
      renderPurgeStatus();
    }
  });

  // ── Threat Intel providers (N7, #20) — all disabled by default ──
  const tiTitle = el('span', `${P}-field-label`, t('settings.ti.title'));
  const tiProvidersList = el('div', `${P}-ti-providers`);
  const customLabelInput = el('input', `${P}-input`);
  customLabelInput.type = 'text';
  customLabelInput.placeholder = t('settings.ti.customLabelPlaceholder');
  const customTypeSelect = el('select', `${P}-input`);
  for (const id of getIndicatorIds()) {
    const opt = el('option', undefined, getIndicatorLabel(id));
    opt.value = id;
    customTypeSelect.appendChild(opt);
  }
  const customTemplateInput = el('input', `${P}-input`);
  customTemplateInput.type = 'text';
  customTemplateInput.placeholder = t('settings.ti.customTemplatePlaceholder');
  const addCustomBtn = button(`${P}-btn`, t('settings.ti.addCustom'));
  const tiAddRow = el('div', `${P}-ti-add`);
  tiAddRow.append(customLabelInput, customTypeSelect, customTemplateInput, addCustomBtn);

  // ── Clients (N2 "Référentiel clients") ──
  //
  // The only manual correspondence table between a Defender tid and a
  // Sentinel workspace resourceId - see the privacy note at the top of
  // core/clients.ts. The values typed here are shown back to the user in
  // this list on purpose (that is the whole point: recognising her own
  // customers); they are never logged (core/clients.ts logs counts only)
  // and never flow into a case export, a report or the diagnostics text.
  const clientsTitle = el('span', `${P}-field-label`, t('settings.clients.title'));
  const clientsList = el('div', `${P}-ti-providers`);

  const clientNameField = field(t('settings.clients.nameLabel'), '', t('settings.clients.namePlaceholder'));

  const clientTidsInput = el('textarea', `${P}-input`);
  clientTidsInput.rows = 2;
  clientTidsInput.spellcheck = false;
  clientTidsInput.placeholder = t('settings.clients.tidsPlaceholder');
  const clientTidsWrap = el('label', `${P}-field`);
  clientTidsWrap.append(el('span', `${P}-field-label`, t('settings.clients.tidsLabel')), clientTidsInput);

  const clientWorkspacesInput = el('textarea', `${P}-input`);
  clientWorkspacesInput.rows = 2;
  clientWorkspacesInput.spellcheck = false;
  clientWorkspacesInput.placeholder = t('settings.clients.workspacesPlaceholder');
  const clientWorkspacesWrap = el('label', `${P}-field`);
  clientWorkspacesWrap.append(
    el('span', `${P}-field-label`, t('settings.clients.workspacesLabel')),
    clientWorkspacesInput,
  );

  // N2 "Import / export du référentiel": a SEPARATE JSON from any case
  // export, and the only EasyPivot file that carries plaintext tenant
  // identifiers. The warning is permanent (hint below) AND repeated as a
  // confirmation before the file is built - see the click handler.
  const clientsExportBtn = button(`${P}-btn`, t('settings.clients.export'));
  const clientsImportBtn = button(`${P}-btn`, t('settings.clients.import'));
  const clientsTransferRow = el('div', `${P}-actions`);
  clientsTransferRow.append(clientsExportBtn, clientsImportBtn);
  const clientsTransferHint = el('div', `${P}-status`, t('settings.clients.transferWarning'));

  const addCurrentTenantBtn = button(`${P}-btn`, t('settings.clients.addCurrentTenant'));
  const addCurrentWorkspaceBtn = button(`${P}-btn`, t('settings.clients.addCurrentWorkspace'));
  const createClientBtn = button(`${P}-btn ${P}-btn--primary`, t('settings.clients.create'));
  const clientFormActions = el('div', `${P}-actions`);
  clientFormActions.append(addCurrentTenantBtn, addCurrentWorkspaceBtn, createClientBtn);

  // ── Cases management (N2 "Actions sur un cas" + retention) ──
  //
  // Lists the cases of the CURRENT scope only (`listAllCasesInScope`, the same
  // partitioning predicate as everywhere else; archived ones included, since
  // they are hidden elsewhere and must stay deletable). The two global actions
  // below show NUMBERS only, never another client's case names.
  const casesTitle = el('span', `${P}-field-label`, t('settings.cases.title'));
  const casesHint = el('div', `${P}-status`, t('settings.cases.hint'));
  const casesStatus = el('div', `${P}-status`);
  const casesList = el('div', `${P}-ti-providers`);
  const casesResult = el('div', `${P}-status`);
  casesResult.hidden = true;
  const deleteArchivedBtn = button(`${P}-btn`, t('settings.cases.deleteArchived', { n: 0 }));
  const deleteAllBtn = button(`${P}-btn`, t('settings.cases.deleteAll'));
  const casesGlobalRow = el('div', `${P}-actions`);
  casesGlobalRow.append(deleteArchivedBtn, deleteAllBtn);

  // ── Case export / import (N2 "Export / import", phase 5d) ──
  //
  // The checkbox is PER-EXPORT UI STATE and is deliberately NOT persisted,
  // neither in its own setting nor by reusing `report.redact`:
  //  - persisting it would make the NEXT export leak by default, the exact
  //    opposite of N2's "valeurs masquées par défaut";
  //  - `report.redact` is about a report pasted into a ticket (5f), a
  //    different act with a different audience. One switch for both would
  //    mean un-masking a case export silently un-masks every later report.
  // So the only input to the masking decision is this box, which starts
  // unchecked every time the panel is built, and `core/case-export.ts`
  // defaults to masked when the flag is absent.
  const caseTransferTitle = el('span', `${P}-field-label`, t('settings.caseExport.title'));
  const caseTransferStatus = el('div', `${P}-status`);
  const caseSelect = el('select', `${P}-input`);
  const includeValuesBox = el('input', `${P}-ti-checkbox`);
  includeValuesBox.type = 'checkbox';
  includeValuesBox.checked = false;
  const includeValuesLabel = el('label', `${P}-ti-provider-label`);
  includeValuesLabel.append(includeValuesBox, document.createTextNode(t('settings.caseExport.includeValues')));
  const includeValuesRow = el('div', `${P}-ti-provider-row`);
  includeValuesRow.appendChild(includeValuesLabel);
  const caseTransferHint = el('div', `${P}-status`, t('settings.caseExport.hint'));
  const caseExportBtn = button(`${P}-btn`, t('settings.caseExport.export'));
  const caseImportBtn = button(`${P}-btn`, t('settings.caseExport.import'));
  const caseTransferRow = el('div', `${P}-actions`);
  caseTransferRow.append(caseExportBtn, caseImportBtn);

  // ── Migration (N2 "Migration", phase 5c, `core/migration.ts`) ──
  //
  // The copy itself (old journal/runs -> cases) runs automatically on load
  // (main.ts) and never touches the old keys; this block only surfaces the
  // two things that stay user-initiated per project rule 8: the JSON export
  // of what is left to migrate (available for as long as old data exists,
  // migrated or not) and "Supprimer l'ancien historique", which is the only
  // thing anywhere that deletes `shq_pivot_snapshots` / `shq_runs_*` - and
  // only once the migration is confirmed. `renderMigration()` decides which
  // of the two buttons make sense to show; both are plain `${P}-btn` (no
  // "danger" variant exists in this codebase, see Clients' own delete button).
  const migrationTitle = el('span', `${P}-field-label`, t('settings.migration.title'));
  const migrationStatus = el('div', `${P}-status`);
  const migrationExportBtn = button(`${P}-btn`, t('settings.migration.export'));
  const migrationDeleteBtn = button(`${P}-btn`, t('settings.migration.deleteOldHistory'));
  const migrationRow = el('div', `${P}-actions`);
  migrationRow.append(migrationExportBtn, migrationDeleteBtn);

  settings.append(
    urlField.wrap,
    settingsActions,
    catalogStatus,
    catalogError,
    catalogWarnings,
    purgeTitle,
    purgeStatus,
    purgeRow, sanitizeRow, sanitizeHint,
    tiTitle,
    tiProvidersList,
    tiAddRow,
    clientsTitle,
    clientsList,
    clientNameField.wrap,
    clientTidsWrap,
    clientWorkspacesWrap,
    clientFormActions,
    clientsTransferRow,
    clientsTransferHint,
    casesTitle,
    casesHint,
    casesStatus,
    casesList,
    casesGlobalRow,
    casesResult,
    caseTransferTitle,
    caseTransferStatus,
    caseSelect,
    includeValuesRow,
    caseTransferHint,
    caseTransferRow,
    migrationTitle,
    migrationStatus,
    migrationRow,
  );

  /** `true` <-> `false` is the only direction that triggers the consent toast (N7). */
  function setProviderEnabled(id: string, enable: boolean): void {
    const ti = getSetting('ti');
    const already = ti.providers.includes(id);
    if (enable === already) return;
    const providers = enable ? [...ti.providers, id] : ti.providers.filter((p) => p !== id);
    setSetting('ti', { ...ti, providers });
    log.debug('ti: provider toggled', { id, enable });
    if (enable) showToast(t('settings.ti.consentWarning'), 'info');
    renderTi();
    onTiChange?.();
  }

  function removeCustomProvider(id: string): void {
    const ti = getSetting('ti');
    setSetting('ti', {
      providers: ti.providers.filter((p) => p !== id),
      custom: ti.custom.filter((p) => p.id !== id),
    });
    renderTi();
    onTiChange?.();
  }

  function addCustomProvider(): void {
    const label = customLabelInput.value.trim();
    const type = customTypeSelect.value as IndicatorId;
    const template = customTemplateInput.value.trim();

    if (!label || !template) return;
    if (!template.startsWith('https://')) {
      showToast(t('settings.ti.invalidScheme'), 'error');
      return;
    }
    if (!template.includes('{value}')) {
      showToast(t('settings.ti.invalidPlaceholder'), 'error');
      return;
    }
    // Belt-and-braces: isValidTiTemplate() is the single source of truth core/ti-links.ts
    // relies on too, so a provider that passes here is one buildTiLinks() will also accept.
    if (!isValidTiTemplate(template)) {
      showToast(t('settings.ti.invalidScheme'), 'error');
      return;
    }

    const provider: TiProvider = { id: newCustomId(), label, templates: { [type]: template } };
    const ti = getSetting('ti');
    setSetting('ti', { ...ti, custom: [...ti.custom, provider] });
    customLabelInput.value = '';
    customTemplateInput.value = '';
    renderTi();
  }

  addCustomBtn.addEventListener('click', addCustomProvider);

  function renderProviderRow(provider: TiProvider, removable: boolean): HTMLDivElement {
    const row = el('div', removable ? `${P}-ti-custom-row` : `${P}-ti-provider-row`);
    const ti = getSetting('ti');
    const checkbox = el('input', `${P}-ti-checkbox`);
    checkbox.type = 'checkbox';
    checkbox.checked = ti.providers.includes(provider.id);
    checkbox.addEventListener('change', () => setProviderEnabled(provider.id, checkbox.checked));
    const labelWrap = el('label', `${P}-ti-provider-label`);
    labelWrap.append(checkbox, document.createTextNode(provider.label));
    row.appendChild(labelWrap);
    if (removable) {
      const removeBtn = button(`${P}-btn`, '✕', t('settings.ti.removeCustom'));
      removeBtn.addEventListener('click', () => removeCustomProvider(provider.id));
      row.appendChild(removeBtn);
    }
    return row;
  }

  function renderTi(): void {
    const ti = getSetting('ti');
    tiProvidersList.replaceChildren();
    for (const provider of BUILTIN_TI_PROVIDERS) {
      tiProvidersList.appendChild(renderProviderRow(provider, false));
    }
    for (const provider of ti.custom) {
      tiProvidersList.appendChild(renderProviderRow(provider, true));
    }
  }

  // ── Files in and out (shared by the three export/import blocks) ──

  /**
   * Reads a user-chosen JSON file as text. Oversized files are refused
   * BEFORE being read (a 50 MB pick must not be loaded into memory to find
   * that out), and the `<input>` is thrown away after one use so picking
   * the same file twice still fires a `change` event. Never throws: a read
   * failure becomes a toast.
   */
  function pickJsonFile(onText: (text: string) => void): void {
    const input = el('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.hidden = true;
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      if (!file) return;
      if (file.size > CASES.MAX_IMPORT_CHARS) {
        showToast(t('settings.import.tooLarge'), 'error');
        return;
      }
      file
        .text()
        .then(onText)
        .catch((err: unknown) => {
          log.error('settings: could not read the chosen file', err);
          showToast(t('settings.import.readFailed'), 'error');
        });
    });
    document.body.appendChild(input);
    input.click();
  }

  // ── Clients behaviour ──

  addCurrentTenantBtn.addEventListener('click', () => {
    const search = typeof location !== 'undefined' ? location.search : '';
    const tid = extractDefenderTidFromSearch(search);
    if (!tid) {
      showToast(t('settings.clients.currentTenantNotFound'), 'error');
      return;
    }
    const values = splitMultiValue(clientTidsInput.value);
    if (!values.includes(tid)) values.push(tid);
    clientTidsInput.value = values.join('\n');
  });

  addCurrentWorkspaceBtn.addEventListener('click', () => {
    const hash = typeof location !== 'undefined' ? location.hash : '';
    const resourceId = extractSentinelResourceIdFromHash(hash);
    if (!resourceId) {
      showToast(t('settings.clients.currentWorkspaceNotFound'), 'error');
      return;
    }
    const values = splitMultiValue(clientWorkspacesInput.value);
    if (!values.includes(resourceId)) values.push(resourceId);
    clientWorkspacesInput.value = values.join('\n');
  });

  createClientBtn.addEventListener('click', () => {
    const result = addClient({
      name: clientNameField.input.value,
      defenderTids: splitMultiValue(clientTidsInput.value),
      sentinelWorkspaces: splitMultiValue(clientWorkspacesInput.value),
    });
    if (!result.ok) {
      showToast(clientMutationErrorMessage(result), 'error');
      return;
    }
    clientNameField.input.value = '';
    clientTidsInput.value = '';
    clientWorkspacesInput.value = '';
    showToast(t('settings.clients.created', { name: result.client.name }), 'info');
    renderClients();
  });

  function renderClientRow(client: Client): HTMLDivElement {
    const row = el('div', `${P}-ti-custom-row`);
    const info = el('div');
    info.appendChild(el('div', `${P}-ti-provider-label`, client.name));
    info.appendChild(
      el(
        'div',
        `${P}-status`,
        t('settings.clients.summary', { tids: client.defenderTids.length, workspaces: client.sentinelWorkspaces.length }),
      ),
    );
    row.appendChild(info);
    const removeBtn = button(`${P}-btn`, t('settings.clients.delete'));
    removeBtn.addEventListener('click', () => {
      if (!window.confirm(t('settings.clients.confirmDelete', { name: client.name }))) return;
      deleteClient(client.id);
      showToast(t('settings.clients.deleted', { name: client.name }), 'info');
      renderClients();
    });
    row.appendChild(removeBtn);
    return row;
  }

  function renderClients(): void {
    clientsList.replaceChildren();
    const clients = getClients();
    if (clients.length === 0) {
      clientsList.appendChild(el('div', `${P}-status`, t('settings.clients.empty')));
      return;
    }
    for (const client of clients) clientsList.appendChild(renderClientRow(client));
  }

  // ── Client registry transfer behaviour (N2, phase 5d) ──

  clientsExportBtn.addEventListener('click', () => {
    // N2: "avec avertissement « contient des identifiants de tenants »".
    // Shown BEFORE anything is built, so a mis-click cannot produce a file
    // holding plaintext tids on disk.
    if (!window.confirm(t('settings.clients.confirmExport'))) return;
    try {
      const data = buildClientsExport();
      downloadJson(`easypivot-clients-${Date.now()}.json`, data);
      showToast(t('settings.clients.exported', { n: data.clients.length }), 'success');
    } catch (err) {
      log.error('settings: client registry export failed', err);
      showToast(t('settings.clients.exportFailed'), 'error');
    }
  });

  clientsImportBtn.addEventListener('click', () => {
    pickJsonFile((text) => {
      const parsed = parseClientsExport(text);
      if (!parsed.ok) {
        showToast(importRefusalMessage(parsed.refusal.code), 'error');
        return;
      }
      const result = importClients(parsed.clients);
      showToast(
        t('settings.clients.imported', {
          added: result.added,
          skipped: result.skipped,
          invalid: result.invalid,
        }),
        'info',
      );
      renderClients();
      // A new client can change which cases are in scope for the current key.
      void refreshCaseScope();
    });
  });

  // ── Case export / import behaviour (N2, phase 5d) ──
  //
  // ASYNC SCOPE, same pattern (and same reason) as `ui/case-bar.ts`: the
  // key -> client index needs `crypto.subtle`, so there is no synchronous
  // "which client am I looking at". The block paints from the last resolved
  // scope and re-resolves in the background; with no scope at all it
  // disables itself instead of exporting into the void.
  let caseScope: CaseImportScope | undefined;
  let scopeResolving = false;

  async function refreshCaseScope(): Promise<void> {
    if (scopeResolving) return;
    scopeResolving = true;
    try {
      const key = options?.getCurrentKey?.();
      if (!key) {
        caseScope = undefined;
        return;
      }
      const index = await buildClientKeyIndex();
      const client = findClientByKey(key, index);
      caseScope = { key, clientId: client?.id, clientKeys: index.byKey };
    } catch (err) {
      log.error('settings: could not resolve the current case scope', err);
      caseScope = undefined;
    } finally {
      scopeResolving = false;
      paintCaseTransfer();
    }
  }

  /** Paint only - never kicks a resolution, so it cannot recurse with `refreshCaseScope()`. */
  function paintCaseTransfer(): void {
    paintCases();
    caseSelect.replaceChildren();
    if (!caseScope) {
      caseTransferStatus.textContent = scopeResolving
        ? t('settings.caseExport.resolving')
        : t('settings.caseExport.noTenant');
      caseSelect.hidden = true;
      caseExportBtn.disabled = true;
      return;
    }
    const choices = listCasesInScope({ key: caseScope.key, clientId: caseScope.clientId });
    caseSelect.hidden = choices.length === 0;
    caseExportBtn.disabled = choices.length === 0;
    if (choices.length === 0) {
      caseTransferStatus.textContent = t('settings.caseExport.noCase');
      return;
    }
    caseTransferStatus.textContent = t('settings.caseExport.count', { n: choices.length });
    for (const c of choices) {
      const shown = caseDisplayName(c);
      const opt = el('option', undefined, c.closedAt !== undefined ? `${shown} — ${t('caseBar.closedBadge')}` : shown);
      opt.value = c.id;
      caseSelect.appendChild(opt);
    }
  }

  function renderCaseTransfer(): void {
    paintCaseTransfer();
    if (!caseScope && !scopeResolving) void refreshCaseScope();
  }

  // Paint once at construction (same precedent as `renderPurgeStatus()`), so
  // the block is never blank if something shows it without calling
  // `renderCaseTransfer()` first.
  paintCaseTransfer();

  /** Builds and downloads one case's export; shared by the 5d block and the per-case "Export (masked)" button. */
  function exportCaseFile(caseId: string, includeValues: boolean): void {
    const data = buildCaseExport(caseId, { includeValues });
    if (!data) {
      showToast(t('settings.caseExport.exportFailed'), 'error');
      return;
    }
    // Timestamped filename, never the case name: the file name itself ends
    // up in a download folder, a backup and sometimes a ticket.
    downloadJson(`easypivot-case-${Date.now()}.json`, data);
    showToast(
      includeValues
        ? t('settings.caseExport.exportedClear', { snapshots: data.snapshots.length, runs: data.runs.length })
        : t('settings.caseExport.exportedMasked', { snapshots: data.snapshots.length, runs: data.runs.length }),
      includeValues ? 'info' : 'success',
    );
  }

  caseExportBtn.addEventListener('click', () => {
    const caseId = caseSelect.value;
    if (!caseId) return;
    const includeValues = includeValuesBox.checked;
    // The opt-in is confirmed, not just ticked: this is the one path that
    // writes real customer values to a file.
    if (includeValues && !window.confirm(t('settings.caseExport.confirmIncludeValues'))) return;
    exportCaseFile(caseId, includeValues);
  });

  caseImportBtn.addEventListener('click', () => {
    if (!caseScope) {
      showToast(t('settings.caseExport.noTenant'), 'error');
      return;
    }
    pickJsonFile((text) => {
      const scope = caseScope;
      if (!scope) return;
      const parsed = parseCaseExport(text);
      if (!parsed.ok) {
        showToast(importRefusalMessage(parsed.refusal.code), 'error');
        return;
      }
      // Design point 4: a masked export must never come back in silently -
      // its `***` / `203.0.x.x` values read as real data otherwise.
      if (parsed.data.redacted && !window.confirm(t('settings.caseExport.confirmRedacted'))) {
        showToast(t('settings.caseExport.importCancelled'), 'info');
        return;
      }
      let result = importCase(parsed.data, scope);
      if (!result.ok && result.reason === 'out-of-scope') {
        // N2's "sauf confirmation explicite", and the only call site of the
        // foreign-key entry point.
        if (!window.confirm(t('settings.caseExport.confirmForeign'))) {
          showToast(t('settings.caseExport.importCancelled'), 'info');
          return;
        }
        result = importCaseAcceptingForeignKeys(parsed.data, scope);
      }
      if (!result.ok) {
        showToast(t('settings.caseExport.importFailed'), 'error');
        return;
      }
      showToast(
        t('settings.caseExport.imported', { name: importedCaseLabel(result.caseId, result.name), snapshots: result.snapshots, runs: result.runs }),
        'success',
      );
      paintCaseTransfer();
      options?.onCasesChanged?.();
    });
  });

  // ── Cases management behaviour ──

  function formatBytes(bytes: number): string {
    return bytes >= 1_000_000
      ? t('settings.cases.sizeMb', { n: (bytes / 1_000_000).toFixed(1) })
      : t('settings.cases.sizeKb', { n: Math.max(1, Math.round(bytes / 1000)) });
  }

  function caseStatusText(entry: CaseIndexEntry): string {
    const parts: string[] = [];
    if (entry.closedAt !== undefined) parts.push(t('settings.cases.status.closed', { date: new Date(entry.closedAt).toLocaleDateString() }));
    if (entry.archivedAt !== undefined) parts.push(t('settings.cases.status.archived', { date: new Date(entry.archivedAt).toLocaleDateString() }));
    return parts.length > 0 ? parts.join(' · ') : t('settings.cases.status.open');
  }

  /** What the Cases section changed: repaint everything that shows cases or their size, and let the case bar re-resolve. */
  function afterCasesChanged(): void {
    paintCaseTransfer();
    renderPurgeStatus();
    options?.onCasesChanged?.();
  }

  function renderCaseRow(entry: CaseIndexEntry): HTMLDivElement {
    const stats = getCaseStats(entry.id);
    const name = caseDisplayName(entry);
    const row = el('div', `${P}-cases-row`);
    row.appendChild(el('div', `${P}-cases-name`, name));
    row.appendChild(
      el(
        'div',
        `${P}-status`,
        t('settings.cases.meta', {
          status: caseStatusText(entry),
          created: new Date(entry.createdAt).toLocaleDateString(),
          last: new Date(entry.lastAccessAt).toLocaleDateString(),
        }),
      ),
    );
    row.appendChild(
      el('div', `${P}-status`, t('settings.cases.stats', { snapshots: stats.snapshots, runs: stats.runs, size: formatBytes(stats.bytes) })),
    );

    const actions = el('div', `${P}-actions`);
    if (entry.archivedAt === undefined) {
      const archiveBtn = button(`${P}-btn`, t('settings.cases.archive'));
      archiveBtn.addEventListener('click', () => {
        const r = archiveCase(entry.id);
        showToast(r.ok ? t('settings.cases.archived', { name }) : t('settings.cases.archiveFailed'), r.ok ? 'info' : 'error');
        afterCasesChanged();
      });
      actions.appendChild(archiveBtn);
    }
    const exportBtn = button(`${P}-btn`, t('settings.cases.exportMasked'));
    exportBtn.addEventListener('click', () => exportCaseFile(entry.id, false));
    actions.appendChild(exportBtn);
    const deleteBtn = button(`${P}-btn`, t('settings.cases.delete'));
    deleteBtn.addEventListener('click', () => {
      // Counts are re-read now, not captured at paint time: the confirm must state what is lost at this moment.
      const live = getCaseStats(entry.id);
      if (!window.confirm(t('settings.cases.confirmDelete', { name, snapshots: live.snapshots, runs: live.runs }))) return;
      const r = deleteCase(entry.id);
      showToast(r.deleted ? t('settings.cases.deleted', { name }) : t('settings.cases.deleteFailed'), r.deleted ? 'info' : 'error');
      afterCasesChanged();
    });
    actions.appendChild(deleteBtn);
    row.appendChild(actions);
    return row;
  }

  function paintCases(): void {
    casesList.replaceChildren();
    // Global actions: numbers only, whatever the scope (they act on every client).
    const archivedCount = getCaseIndexEntries().filter((c) => c.archivedAt !== undefined).length;
    deleteArchivedBtn.textContent = t('settings.cases.deleteArchived', { n: archivedCount });
    deleteArchivedBtn.disabled = archivedCount === 0;
    // Cheap check (no body parsing): anything indexed, or any tenant run buffer.
    deleteAllBtn.disabled = getCaseIndexEntries().length === 0 && getKnownTenantKeys().length === 0;

    if (!caseScope) {
      casesStatus.hidden = false;
      casesStatus.textContent = scopeResolving ? t('settings.caseExport.resolving') : t('settings.caseExport.noTenant');
      return;
    }
    const entries = [...listAllCasesInScope({ key: caseScope.key, clientId: caseScope.clientId })].sort(
      (a, b) => b.lastAccessAt - a.lastAccessAt,
    );
    casesStatus.hidden = entries.length > 0;
    casesStatus.textContent = entries.length > 0 ? '' : t('settings.cases.empty');
    for (const entry of entries) casesList.appendChild(renderCaseRow(entry));
  }

  deleteArchivedBtn.addEventListener('click', () => {
    const n = getCaseIndexEntries().filter((c) => c.archivedAt !== undefined).length;
    if (n === 0) return;
    if (!window.confirm(t('settings.cases.confirmDeleteArchived', { n }))) return;
    const r = deleteArchivedCases();
    casesResult.textContent = t('settings.cases.deletedArchived', { n: r.cases }) + (r.failed > 0 ? t('settings.cases.deletedAllPartial', { n: r.failed }) : '');
    casesResult.hidden = false;
    showToast(t('settings.cases.deletedArchived', { n: r.cases }), 'info');
    afterCasesChanged();
  });

  deleteAllBtn.addEventListener('click', () => {
    const before = countAllCaptureData();
    const oldHistory = hasOldSnapshots();
    const section = t('settings.migration.title');
    const message =
      t('settings.cases.confirmDeleteAll', { cases: before.cases, runs: before.runs }) +
      (oldHistory ? t('settings.cases.confirmDeleteAllOld', { section }) : '');
    if (!window.confirm(message)) return;
    const r = deleteAllCaptureData();
    clearLastCapture(); // the in-memory copy of the last result is capture data too
    const runs = r.runs + r.bufferRuns;
    casesResult.textContent =
      t('settings.cases.deletedAll', { cases: r.cases, runs }) +
      (r.failed > 0 ? t('settings.cases.deletedAllPartial', { n: r.failed }) : '') +
      (hasOldSnapshots() ? t('settings.cases.deletedAllOld', { section }) : '');
    casesResult.hidden = false;
    showToast(t('settings.cases.deletedAll', { cases: r.cases, runs }), 'info');
    renderMigration();
    afterCasesChanged();
  });

  // ── Migration behaviour ──

  migrationExportBtn.addEventListener('click', () => {
    try {
      const data = buildMigrationExport();
      downloadJson(`easypivot-history-export-${Date.now()}.json`, data);
      log.info('migration: export downloaded', {
        snapshots: data.snapshots.length,
        tenantsWithRuns: Object.keys(data.runs).length,
      });
      showToast(t('settings.migration.exported'), 'success');
    } catch (err) {
      log.error('settings: migration export failed', err);
      showToast(t('settings.migration.exportFailed'), 'error');
    }
  });

  migrationDeleteBtn.addEventListener('click', () => {
    if (!window.confirm(t('settings.migration.confirmDelete'))) return;
    const result = deleteOldHistory();
    log.info('settings: old history deletion requested', result);
    showToast(t('settings.migration.deleted'), 'info');
    renderMigration();
  });

  function renderMigration(): void {
    const confirmedAt = getMigrationConfirmedAt();
    const oldHistoryLeft = hasOldHistory();

    if (confirmedAt !== undefined) {
      migrationStatus.textContent = oldHistoryLeft
        ? t('settings.migration.doneKeptOld', { date: new Date(confirmedAt).toLocaleString() })
        : t('settings.migration.doneClean', { date: new Date(confirmedAt).toLocaleString() });
    } else {
      migrationStatus.textContent = oldHistoryLeft ? t('settings.migration.pending') : t('settings.migration.nothing');
    }

    migrationExportBtn.hidden = !oldHistoryLeft;
    migrationDeleteBtn.hidden = !(confirmedAt !== undefined && oldHistoryLeft);
  }

  function renderStatus(): void {
    const st = getCatalogStatus();
    const source =
      st.source === 'bundled'
        ? t('settings.sourceBundled')
        : st.source === 'cache'
          ? t('settings.sourceCache', { age: relativeAge(st.fetchedAt) })
          : t('settings.sourceRemote', { age: relativeAge(st.fetchedAt) });
    catalogStatus.textContent = t('settings.catalogStatus', {
      version: st.version,
      count: st.ruleCount,
      source,
    });
    catalogError.textContent = st.error ? t('settings.downloadFailed', { error: st.error }) : '';
    catalogError.hidden = !st.error;

    // Non-blocking catalog problems: one line each, as plain text
    catalogWarnings.textContent = '';
    if (st.warnings.length > 0) {
      catalogWarnings.appendChild(el('div', undefined, t('settings.catalogWarningsLabel')));
      for (const w of st.warnings) catalogWarnings.appendChild(el('div', undefined, w));
    }
    catalogWarnings.hidden = st.warnings.length === 0;
  }

  return {
    root: settings,
    urlField,
    saveUrlBtn,
    defaultUrlBtn,
    catalogStatus,
    catalogError,
    catalogWarnings,
    renderStatus,
    renderTi,
    renderClients,
    renderMigration,
    renderCaseTransfer,
  };
}
