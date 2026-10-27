import type { Case, PlatformAdapter, PlatformId, TenantKey } from '../types.ts';
import { CSS_PREFIX } from '../config.ts';
import {
  createCase,
  ensureUnassignedCase,
  listCasesInScope,
  resolveActiveCaseForKey,
  switchActiveCase,
  type ActiveCaseResolution,
  type CaseScope,
} from '../core/cases.ts';
import { addClient, attachDefenderTid, attachSentinelWorkspace, getClients } from '../core/clients.ts';
import {
  defenderKey,
  extractDefenderTidFromSearch,
  extractSentinelResourceIdFromHash,
  sentinelKey,
  UNKNOWN_KEY,
} from '../core/tenant.ts';
import { getLastResolvedTenantKey, onTenantKeyChanged } from '../capture/store.ts';
import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { caseDisplayName } from './case-name.ts';
import { showToast } from './notification.ts';
import { P, el, button } from './panel/shared.ts';

/**
 * Active-case banner (N2 "Règle de choix du cas actif" + "Cloisonnement").
 * Thin on purpose: ALL the logic (which case is active, which cases share a
 * scope, whether a pivot is allowed) lives in `core/cases.ts` — this module
 * only renders the three `ActiveCaseResolution` branches and dispatches the
 * user's choice back into `core/cases.ts` / `core/clients.ts`.
 *
 * ASYNC RESOLUTION, HONESTLY: `resolveActiveCaseForKey()` needs the client
 * index (`core/clients.ts`, itself async — `crypto.subtle`), so there is no
 * synchronous "current state" the very first time this renders. Rather than
 * block the panel on that await, the bar starts with `state = null` (renders
 * `caseBar.resolving`) and flips to a real state once `refresh()` settles —
 * exactly once, resolved outside `render()`'s control flow. On every
 * SUBSEQUENT `refresh()` (the panel re-opening, a tab regaining focus) the
 * bar keeps showing the LAST state while it quietly re-resolves in the
 * background, and only repaints once the new result is in. This is what
 * keeps it from flickering back to "resolving…" on every panel open: within
 * one page load the tenant key does not change (core/tenant.ts's own
 * contract — a workspace/tenant only changes on navigation, and a
 * navigation tears down and recreates this whole component, see
 * `ui/pivot-trigger.ts`/`main.ts`), so almost every `refresh()` after the
 * first one reaches the exact same conclusion and the repaint is a no-op.
 *
 * CURRENT TENANT KEY, HONESTLY: there are two sources and neither alone is
 * enough for everything this bar needs.
 * - `capture/store.ts`'s `getLastResolvedTenantKey()` is the hashed key a
 *   REAL captured request already resolved — authoritative when it exists,
 *   but `null` until the first query runs on this page load.
 * - `core/tenant.ts`'s extraction helpers read the raw `tid` (Defender,
 *   `location.search`) or workspace resourceId (Sentinel, the iframe URL
 *   hash) synchronously, before any request — but that raw value is also
 *   the ONLY thing the "attach to a client" / "create a client" actions
 *   below can prefill, and a resolved `TenantKey` cannot be un-hashed back
 *   into it.
 * So: the key used for `resolveActiveCaseForKey()` prefers the captured one
 * (matches exactly what capture/store.ts itself partitions by) and falls
 * back to hashing the extracted raw value; the raw value itself is read
 * independently, every time, purely for the two client-registry actions —
 * if extraction fails (no `tid`/resourceId on this page yet) those two
 * actions are hidden rather than guessing, and the key degrades to
 * `'unknown'` (N2 point 4: pivot stays possible via the "create a case"
 * shortcut below, routed into an unassigned case, never silently blocked).
 *
 * KEY CHANGES: the first capture of a page load turns the key from "not known
 * yet" (resolved above as `unknown` or from the URL) into the real one. The bar
 * subscribes to `capture/store.ts`'s `onTenantKeyChanged` - fired once, right
 * after `addRun()` resolved the key, and only when it differs - and re-resolves
 * then. No polling, and a capture that confirms the same key repaints nothing.
 * Resolving NEVER creates a case: the "unassigned" case for an unreadable key
 * is provisioned lazily, when a pivot is launched (`ui/pivot-menu.ts`).
 *
 * PRIVACY: the raw `tid`/resourceId is shown back to the user in this bar
 * exactly like `ui/panel/settings-view.ts`'s Clients section already does —
 * that is the point, so she recognises her own tenant — but it is never
 * logged (only counts/ids are, below) and never leaves this component.
 */

export interface CaseBarView {
  readonly root: HTMLDivElement;
  /** Re-resolves the active case for the current key; never throws. Repaints when it settles. */
  refresh(): Promise<void>;
  /**
   * Resolves once if nothing has resolved yet (sharing an in-flight
   * `refresh()` instead of starting a second one), then returns
   * immediately once any state exists. The pivot guard in
   * `ui/pivot-menu.ts` awaits this before reading `getCurrentKey()`, so it
   * never sees "not yet known" on a normal click — only a genuine failure
   * (caught inside `refresh()`) leaves it at `UNKNOWN_KEY`.
   */
  ensureResolved(): Promise<void>;
  /**
   * The tenant key resolved by the last `refresh()`, or `undefined` before
   * the very first one has settled.
   */
  getCurrentKey(): TenantKey | undefined;
}

interface RawTenant {
  readonly kind: 'tid' | 'resourceId';
  readonly value: string;
}

interface CaseBarState {
  readonly key: TenantKey;
  readonly raw: RawTenant | null;
  readonly resolution: ActiveCaseResolution;
}

/** Reads the raw tid/resourceId straight off the page, like `settings-view.ts`'s "add current" buttons. */
function readRawTenant(platformId: PlatformId): RawTenant | null {
  try {
    if (platformId === 'sentinel') {
      const hash = typeof location !== 'undefined' ? location.hash : '';
      const resourceId = extractSentinelResourceIdFromHash(hash);
      return resourceId ? { kind: 'resourceId', value: resourceId } : null;
    }
    const search = typeof location !== 'undefined' ? location.search : '';
    const tid = extractDefenderTidFromSearch(search);
    return tid ? { kind: 'tid', value: tid } : null;
  } catch {
    return null;
  }
}

/** Prefers the key a real captured request already resolved; else hashes the raw value just read. */
async function resolveCurrentKey(platformId: PlatformId, raw: RawTenant | null): Promise<TenantKey> {
  const captured = getLastResolvedTenantKey();
  if (captured) return captured;
  return platformId === 'sentinel' ? sentinelKey(raw?.value) : defenderKey(raw?.value);
}

export interface CaseBarOptions {
  /** Called after every resolution settles (and the bar repainted) - lets the panel refresh what depends on the active case. */
  readonly onResolved?: () => void;
  /** Shows a « Vue du cas » button next to the active case (N3, 5e-2); the host owns the view */
  readonly onOpenCaseView?: () => void;
}

export function createCaseBar(platform: PlatformAdapter, options?: CaseBarOptions): CaseBarView {
  const root = el('div', `${P}-case-bar`);
  let state: CaseBarState | null = null;
  let pending: Promise<void> | null = null;

  // ── Resolution ──

  function refresh(): Promise<void> {
    const run = (async () => {
      try {
        const raw = readRawTenant(platform.id);
        const key = await resolveCurrentKey(platform.id, raw);
        const resolution = await resolveActiveCaseForKey(key);
        state = { key, raw, resolution };
      } catch (err) {
        // Hard constraint: never throw into the panel. Degrades to the
        // same "unknown tenant" state N2 point 4 describes for a genuinely
        // unresolvable key, so a pivot stays possible via the "create a
        // case" shortcut rather than leaving the bar (and the guard that
        // reads getCurrentKey()) stuck with no key at all.
        log.error('case-bar: resolution failed, degrading to the unknown-tenant state', err);
        state = { key: UNKNOWN_KEY, raw: null, resolution: { kind: 'offer-unknown-tenant' } };
      } finally {
        pending = null;
        render();
        try {
          options?.onResolved?.();
        } catch (err) {
          log.error('case-bar: onResolved callback failed', err);
        }
      }
    })();
    pending = run;
    return run;
  }

  async function ensureResolved(): Promise<void> {
    if (state) return;
    if (pending) {
      await pending;
      return;
    }
    await refresh();
  }

  /** Re-resolve when the captured key differs from the one the bar shows (waits for an in-flight resolution first). */
  async function syncWithCapturedKey(): Promise<void> {
    try {
      if (pending) await pending;
      const captured = getLastResolvedTenantKey();
      if (!captured || !state || state.key === captured) return;
      await refresh();
    } catch (err) {
      log.error('case-bar: re-resolving after a tenant key change failed', err);
    }
  }
  onTenantKeyChanged(() => void syncWithCapturedKey());

  // ── Actions — each re-resolves afterwards so the bar reflects the new truth ──

  async function doCreateCase(name: string, clientId: string | undefined, key: TenantKey): Promise<void> {
    const result = createCase({ name, clientId, tenantKeys: [key] });
    if (!result.ok) {
      showToast(t('caseBar.createFailed'), 'error');
      return;
    }
    showToast(t('caseBar.created', { name: caseDisplayName(result.case) }), 'info');
    await refresh();
  }

  async function doSwitch(key: TenantKey, caseId: string): Promise<void> {
    const result = switchActiveCase(key, caseId);
    if (!result.ok) {
      showToast(t('caseBar.switchFailed'), 'error');
      return;
    }
    showToast(t('caseBar.switched', { name: caseDisplayName(result.case) }), 'info');
    await refresh();
  }

  async function doAttach(clientId: string, raw: RawTenant): Promise<void> {
    const result =
      raw.kind === 'resourceId' ? attachSentinelWorkspace(clientId, raw.value) : attachDefenderTid(clientId, raw.value);
    if (!result.ok) {
      showToast(t('caseBar.attachFailed'), 'error');
      return;
    }
    showToast(t('caseBar.attached', { client: result.client.name }), 'info');
    await refresh();
  }

  async function doCreateClient(name: string, raw: RawTenant): Promise<void> {
    const result = addClient({
      name,
      defenderTids: raw.kind === 'tid' ? [raw.value] : undefined,
      sentinelWorkspaces: raw.kind === 'resourceId' ? [raw.value] : undefined,
    });
    if (!result.ok) {
      showToast(t('caseBar.createClientFailed'), 'error');
      return;
    }
    showToast(t('caseBar.clientCreated', { name: result.client.name }), 'info');
    await refresh();
  }

  // ── Render ──

  function render(): void {
    root.replaceChildren();
    if (!state) {
      root.appendChild(el('div', `${P}-status`, t('caseBar.resolving')));
      return;
    }
    if (state.resolution.kind === 'active') {
      renderActive(state.key, state.resolution);
    } else if (state.resolution.kind === 'offer-new-case-for-client') {
      renderOfferNewCaseForClient(state.key, state.resolution);
    } else if (state.resolution.kind === 'unreadable-tenant') {
      renderUnreadableTenant(state.raw);
    } else {
      renderOfferUnknownTenant(state.key, state.raw);
    }
  }

  function renderActive(key: TenantKey, resolution: Extract<ActiveCaseResolution, { kind: 'active' }>): void {
    const row = el('div', `${P}-case-bar-row`);
    row.appendChild(el('span', `${P}-case-bar-name`, t('caseBar.active', { name: caseDisplayName(resolution.case) })));
    if (resolution.case.closedAt !== undefined) {
      row.appendChild(el('span', `${CSS_PREFIX}-badge ${P}-badge--closed`, t('caseBar.closedBadge')));
    }
    const openView = options?.onOpenCaseView;
    if (openView) {
      const viewBtn = button(`${P}-btn ${P}-case-view-btn`, t('caseView.title'), t('caseView.openTitle'));
      viewBtn.addEventListener('click', openView);
      row.appendChild(viewBtn);
    }
    root.appendChild(row);
    if (resolution.client) {
      root.appendChild(el('div', `${P}-status`, t('caseBar.client', { name: resolution.client.name })));
    }
    appendCaseSwitcher(key, resolution.case, resolution.client?.id);
  }

  /** Only shown when there is actually something else in scope to switch to. */
  function appendCaseSwitcher(key: TenantKey, active: Case, clientId: string | undefined): void {
    const scope: CaseScope = { key, clientId };
    const choices = listCasesInScope(scope);
    if (choices.length < 2) return;

    const row = el('div', `${P}-actions`);
    const select = el('select', `${P}-input`);
    for (const c of choices) {
      const shown = caseDisplayName(c);
      const label = c.closedAt !== undefined ? `${shown} — ${t('caseBar.closedBadge')}` : shown;
      const opt = el('option', undefined, label);
      opt.value = c.id;
      opt.selected = c.id === active.id;
      select.appendChild(opt);
    }
    const switchBtn = button(`${P}-btn`, t('caseBar.changeCase'));
    switchBtn.addEventListener('click', () => void doSwitch(key, select.value));
    row.append(select, switchBtn);
    root.appendChild(row);
  }

  function renderOfferNewCaseForClient(
    key: TenantKey,
    resolution: Extract<ActiveCaseResolution, { kind: 'offer-new-case-for-client' }>,
  ): void {
    root.appendChild(el('div', `${P}-status`, t('caseBar.offerNewCaseForClient', { client: resolution.client.name })));
    const row = el('div', `${P}-actions`);
    const createBtn = button(`${P}-btn ${P}-btn--primary`, t('caseBar.createCase'));
    createBtn.addEventListener('click', () => {
      void doCreateCase(t('caseBar.defaultCaseName', { client: resolution.client.name }), resolution.client.id, key);
    });
    row.appendChild(createBtn);
    root.appendChild(row);
  }

  /** Key `unknown`: the tenant could not be read. A pivot is still allowed (N2 point 4) and is filed in the unassigned case. */
  function renderUnreadableTenant(raw: RawTenant | null): void {
    root.appendChild(el('div', `${P}-status`, t('caseBar.offerUnreadableTenant')));
    const quickRow = el('div', `${P}-actions`);
    const createBtn = button(`${P}-btn`, t('caseBar.createUnassigned'));
    createBtn.addEventListener('click', () => {
      const made = ensureUnassignedCase();
      showToast(t('caseBar.created', { name: caseDisplayName(made) }), 'info');
      void refresh();
    });
    quickRow.appendChild(createBtn);
    root.appendChild(quickRow);
    appendClientActions(raw);
  }

  /** A REAL key with no client and no open case yet: the user chooses where its data goes. */
  function renderOfferUnknownTenant(key: TenantKey, raw: RawTenant | null): void {
    root.appendChild(el('div', `${P}-status`, t('caseBar.offerUnknownTenant')));
    const quickRow = el('div', `${P}-actions`);
    const createCaseBtn = button(`${P}-btn ${P}-btn--primary`, t('caseBar.createCase'));
    createCaseBtn.addEventListener('click', () => {
      void doCreateCase(t('caseBar.defaultTenantCaseName'), undefined, key);
    });
    quickRow.appendChild(createCaseBtn);
    root.appendChild(quickRow);
    appendClientActions(raw);
  }

  function appendClientActions(raw: RawTenant | null): void {
    // Nothing to attach or prefill without a tid/resourceId actually read
    // off the page (hard constraint: never invent one).
    if (!raw) return;

    // Saisie assistée, path 1: attach the current tenant to an existing client.
    const clients = getClients();
    if (clients.length > 0) {
      const attachRow = el('div', `${P}-actions`);
      const select = el('select', `${P}-input`);
      for (const c of clients) {
        const opt = el('option', undefined, c.name);
        opt.value = c.id;
        select.appendChild(opt);
      }
      const attachBtn = button(`${P}-btn`, t('caseBar.attachToClient'));
      attachBtn.addEventListener('click', () => void doAttach(select.value, raw));
      attachRow.append(select, attachBtn);
      root.appendChild(attachRow);
    } else {
      root.appendChild(el('div', `${P}-status`, t('settings.clients.empty')));
    }

    // Saisie assistée, path 2: create a client prefilled with the current tid/workspace.
    const createRow = el('div', `${P}-actions`);
    const nameInput = el('input', `${P}-input`);
    nameInput.type = 'text';
    nameInput.placeholder = t('caseBar.newClientNamePlaceholder');
    const createClientBtn = button(`${P}-btn`, t('caseBar.createClient'));
    createClientBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) {
        showToast(t('caseBar.newClientNameRequired'), 'error');
        return;
      }
      void doCreateClient(name, raw);
    });
    createRow.append(nameInput, createClientBtn);
    root.appendChild(createRow);
  }

  render();

  return {
    root,
    refresh,
    ensureResolved,
    getCurrentKey: () => state?.key,
  };
}
