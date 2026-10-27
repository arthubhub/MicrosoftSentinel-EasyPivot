import type { Client, PlatformVariant, TenantKey } from '../types.ts';
import { STORAGE_KEYS } from '../config.ts';
import { getJson, setJson } from './storage.ts';
import { defenderKey, isUnknownTenantKey, sentinelKey } from './tenant.ts';
import { log } from './log.ts';

/**
 * Client registry (N2 "Référentiel clients"). A Sentinel workspace and a
 * Defender tenant belonging to the same customer share no common identifier
 * in their URLs (21/10 survey), so the only way to know they are the same
 * customer is this correspondence table, typed once by the user.
 *
 * PRIVACY: `shq_clients` is the ONLY place in the whole product where a
 * `tid` or a workspace resourceId is stored in clear text — deliberate,
 * because the user types them herself to recognise her own customers. This
 * module must never be imported by a case export, a report, an issue
 * builder or `core/health.ts`'s diagnostics text. Nothing in here is logged
 * above `debug`, and logged payloads carry counts only, never a client name,
 * a `tid` or a resourceId (see the `log.debug` calls below).
 *
 * DOM-free, like every other `core/*` module: the Settings → Clients UI
 * (`ui/panel/settings-view.ts`) owns the form and the "current tenant" /
 * "current workspace" prefill, using `core/tenant.ts`'s extraction helpers
 * itself. This module only validates, stores and resolves.
 */

// ── Storage shape ──

interface ClientsRegistry {
  readonly version: 1;
  readonly clients: readonly Client[];
}

const EMPTY_REGISTRY: ClientsRegistry = { version: 1, clients: [] };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Defensive, field-by-field check — never trust what `JSON.parse` handed back. */
function isClient(v: unknown): v is Client {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    isStringArray(c.defenderTids) &&
    isStringArray(c.sentinelWorkspaces) &&
    typeof c.createdAt === 'number' &&
    (c.notes === undefined || typeof c.notes === 'string') &&
    (c.variant === undefined || c.variant === 'sentinel' || c.variant === 'defender' || c.variant === 'defender-unified')
  );
}

/**
 * Reads `shq_clients`, degrading to an empty registry on anything
 * unexpected (hard constraint: a corrupt value must never throw and must
 * never break the panel). A wrong top-level shape (string, number, missing
 * `clients` array, …) empties the whole registry; a `clients` array that
 * merely contains some bad entries only drops those entries, so one
 * corrupted client does not wipe out the others.
 */
function readRegistry(): ClientsRegistry {
  const raw = getJson<unknown>(STORAGE_KEYS.CLIENTS, null);
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    (raw as Record<string, unknown>).version !== 1 ||
    !Array.isArray((raw as Record<string, unknown>).clients)
  ) {
    if (raw !== null) log.debug('clients: stored registry has an unexpected shape, using an empty registry');
    return EMPTY_REGISTRY;
  }
  const clients = ((raw as Record<string, unknown>).clients as unknown[]).filter(isClient);
  return { version: 1, clients };
}

function writeRegistry(registry: ClientsRegistry): void {
  setJson(STORAGE_KEYS.CLIENTS, registry);
}

// ── Reads ──

export function getClients(): readonly Client[] {
  return readRegistry().clients;
}

export function getClient(id: string): Client | undefined {
  return getClients().find((c) => c.id === id);
}

/** The client (other than `excludeClientId`) that already declares this normalized tid, if any. */
export function findClientOwningTid(tid: string, excludeClientId?: string): Client | undefined {
  return getClients().find((c) => c.id !== excludeClientId && c.defenderTids.includes(tid));
}

/** The client (other than `excludeClientId`) that already declares this normalized workspace, if any. */
export function findClientOwningWorkspace(resourceId: string, excludeClientId?: string): Client | undefined {
  return getClients().find((c) => c.id !== excludeClientId && c.sentinelWorkspaces.includes(resourceId));
}

// ── Validation ──
//
// Format only — the duplicate-across-clients check is stateful (needs the
// registry) and lives in the mutation functions below, so these two stay
// pure and independently testable.

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same segment as `core/tenant.ts`'s `SENTINEL_WORKSPACE_PATH`, anchored for a full-value check. */
const RESOURCE_ID_RE =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/microsoft\.operationalinsights\/workspaces\/[^/]+$/i;

export type FormatReason = 'empty' | 'invalid-format';
export type FormatValidation = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: FormatReason };

/** `tid` must look like a GUID. Normalizes to lowercase, trimmed. */
export function validateDefenderTid(raw: string): FormatValidation {
  const value = raw.trim().toLowerCase();
  if (!value) return { ok: false, reason: 'empty' };
  if (!GUID_RE.test(value)) return { ok: false, reason: 'invalid-format' };
  return { ok: true, value };
}

/**
 * `resourceId` must match the Sentinel workspace path. Normalizes to
 * lowercase with any trailing slash stripped (N2: "normalisés en minuscules"),
 * same convention as `core/tenant.ts`'s `normalizeResourceId`.
 */
export function validateSentinelWorkspace(raw: string): FormatValidation {
  const value = raw.trim().toLowerCase().replace(/\/+$/, '');
  if (!value) return { ok: false, reason: 'empty' };
  if (!RESOURCE_ID_RE.test(value)) return { ok: false, reason: 'invalid-format' };
  return { ok: true, value };
}

// ── CRUD ──

export type ClientMutationReason = FormatReason | 'duplicate' | 'empty-name' | 'not-found';

/**
 * `field`/`value` identify what was rejected so the UI can point at the
 * right input; `value` is the plain text the user typed, meant to be echoed
 * back in the form, never logged (see the module-level privacy note).
 */
export type ClientMutationResult =
  | { readonly ok: true; readonly client: Client }
  | { readonly ok: false; readonly reason: ClientMutationReason; readonly field?: 'name' | 'tid' | 'workspace'; readonly value?: string };

function newClientId(): string {
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type ResolveListResult = { readonly values: readonly string[] } | { readonly fail: ClientMutationResult };

/** Validates + dedupes a raw list of tids against format AND the rest of the registry. */
function resolveTids(raw: readonly string[], excludeClientId: string | undefined): ResolveListResult {
  const values: string[] = [];
  for (const entry of new Set(raw.map((r) => r.trim().toLowerCase()).filter(Boolean))) {
    const v = validateDefenderTid(entry);
    if (!v.ok) return { fail: { ok: false, reason: v.reason, field: 'tid', value: entry } };
    if (findClientOwningTid(v.value, excludeClientId)) {
      return { fail: { ok: false, reason: 'duplicate', field: 'tid', value: entry } };
    }
    values.push(v.value);
  }
  return { values };
}

/** Validates + dedupes a raw list of workspaces against format AND the rest of the registry. */
function resolveWorkspaces(raw: readonly string[], excludeClientId: string | undefined): ResolveListResult {
  const values: string[] = [];
  for (const entry of new Set(raw.map((r) => r.trim().toLowerCase()).filter(Boolean))) {
    const v = validateSentinelWorkspace(entry);
    if (!v.ok) return { fail: { ok: false, reason: v.reason, field: 'workspace', value: entry } };
    if (findClientOwningWorkspace(v.value, excludeClientId)) {
      return { fail: { ok: false, reason: 'duplicate', field: 'workspace', value: entry } };
    }
    values.push(v.value);
  }
  return { values };
}

/**
 * Creates a client. All tids/workspaces are validated (format + no overlap
 * with an existing client) BEFORE anything is written, so a bad entry never
 * leaves a half-created client behind.
 */
export function addClient(input: {
  readonly name: string;
  readonly defenderTids?: readonly string[];
  readonly sentinelWorkspaces?: readonly string[];
  readonly notes?: string;
}): ClientMutationResult {
  const name = input.name.trim();
  if (!name) return { ok: false, reason: 'empty-name', field: 'name' };

  const tids = resolveTids(input.defenderTids ?? [], undefined);
  if ('fail' in tids) return tids.fail;
  const workspaces = resolveWorkspaces(input.sentinelWorkspaces ?? [], undefined);
  if ('fail' in workspaces) return workspaces.fail;

  const client: Client = {
    id: newClientId(),
    name,
    defenderTids: tids.values,
    sentinelWorkspaces: workspaces.values,
    createdAt: Date.now(),
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
  };
  const registry = readRegistry();
  writeRegistry({ version: 1, clients: [...registry.clients, client] });
  log.debug('clients: added', { totalClients: registry.clients.length + 1 });
  return { ok: true, client };
}

export function renameClient(id: string, name: string): ClientMutationResult {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'empty-name', field: 'name' };
  const registry = readRegistry();
  const existing = registry.clients.find((c) => c.id === id);
  if (!existing) return { ok: false, reason: 'not-found' };
  const client: Client = { ...existing, name: trimmed };
  writeRegistry({ version: 1, clients: registry.clients.map((c) => (c.id === id ? client : c)) });
  log.debug('clients: renamed', { totalClients: registry.clients.length });
  return { ok: true, client };
}

export function attachDefenderTid(clientId: string, rawTid: string): ClientMutationResult {
  const registry = readRegistry();
  const existing = registry.clients.find((c) => c.id === clientId);
  if (!existing) return { ok: false, reason: 'not-found' };

  const v = validateDefenderTid(rawTid);
  if (!v.ok) return { ok: false, reason: v.reason, field: 'tid', value: rawTid };
  if (existing.defenderTids.includes(v.value)) return { ok: true, client: existing }; // idempotent
  if (findClientOwningTid(v.value, clientId)) return { ok: false, reason: 'duplicate', field: 'tid', value: rawTid };

  const client: Client = { ...existing, defenderTids: [...existing.defenderTids, v.value] };
  writeRegistry({ version: 1, clients: registry.clients.map((c) => (c.id === clientId ? client : c)) });
  log.debug('clients: tid attached', { clientTidCount: client.defenderTids.length });
  return { ok: true, client };
}

export function detachDefenderTid(clientId: string, rawTid: string): ClientMutationResult {
  const registry = readRegistry();
  const existing = registry.clients.find((c) => c.id === clientId);
  if (!existing) return { ok: false, reason: 'not-found' };
  const value = rawTid.trim().toLowerCase();
  const client: Client = { ...existing, defenderTids: existing.defenderTids.filter((t) => t !== value) };
  writeRegistry({ version: 1, clients: registry.clients.map((c) => (c.id === clientId ? client : c)) });
  log.debug('clients: tid detached', { clientTidCount: client.defenderTids.length });
  return { ok: true, client };
}

export function attachSentinelWorkspace(clientId: string, rawResourceId: string): ClientMutationResult {
  const registry = readRegistry();
  const existing = registry.clients.find((c) => c.id === clientId);
  if (!existing) return { ok: false, reason: 'not-found' };

  const v = validateSentinelWorkspace(rawResourceId);
  if (!v.ok) return { ok: false, reason: v.reason, field: 'workspace', value: rawResourceId };
  if (existing.sentinelWorkspaces.includes(v.value)) return { ok: true, client: existing }; // idempotent
  if (findClientOwningWorkspace(v.value, clientId)) return { ok: false, reason: 'duplicate', field: 'workspace', value: rawResourceId };

  const client: Client = { ...existing, sentinelWorkspaces: [...existing.sentinelWorkspaces, v.value] };
  writeRegistry({ version: 1, clients: registry.clients.map((c) => (c.id === clientId ? client : c)) });
  log.debug('clients: workspace attached', { clientWorkspaceCount: client.sentinelWorkspaces.length });
  return { ok: true, client };
}

export function detachSentinelWorkspace(clientId: string, rawResourceId: string): ClientMutationResult {
  const registry = readRegistry();
  const existing = registry.clients.find((c) => c.id === clientId);
  if (!existing) return { ok: false, reason: 'not-found' };
  const value = rawResourceId.trim().toLowerCase().replace(/\/+$/, '');
  const client: Client = { ...existing, sentinelWorkspaces: existing.sentinelWorkspaces.filter((w) => w !== value) };
  writeRegistry({ version: 1, clients: registry.clients.map((c) => (c.id === clientId ? client : c)) });
  log.debug('clients: workspace detached', { clientWorkspaceCount: client.sentinelWorkspaces.length });
  return { ok: true, client };
}

/**
 * Deletes a client. Per N2, this must NOT delete any case: cases are phase
 * 5b and do not exist yet, so this only removes the registry entry and
 * notifies `onClientDeleted` subscribers — see the hook section below for
 * what 5b is expected to do with that notification.
 */
export function deleteClient(id: string): boolean {
  const registry = readRegistry();
  if (!registry.clients.some((c) => c.id === id)) return false;
  writeRegistry({ version: 1, clients: registry.clients.filter((c) => c.id !== id) });
  log.debug('clients: deleted', { totalClients: registry.clients.length - 1 });
  for (const fn of deleteListeners) fn(id);
  return true;
}

// ── Hook for phase 5b (core/cases.ts) ──
//
// N2: "suppression avec confirmation (les cas restent, leur `clientId` est
// vidé)". Cases do not exist in this phase, so `core/clients.ts` cannot clear
// `Case.clientId` itself without importing a module that does not exist yet.
// Instead it publishes the deleted id; once `core/cases.ts` exists it is
// expected to call `onClientDeleted(clearClientIdFromCases)` once, at module
// load, the same way `core/health.ts` subscribes to
// `capture/interceptor.ts`'s `onCaptureResult`.
const deleteListeners = new Set<(clientId: string) => void>();

export function onClientDeleted(fn: (clientId: string) => void): () => void {
  deleteListeners.add(fn);
  return () => deleteListeners.delete(fn);
}

// ── Resolution (N2 "Résolution") ──
//
// `defenderKey`/`sentinelKey` (core/tenant.ts) are async (`crypto.subtle`),
// so building a hash -> clientId index is async too — there is no honest way
// around that, same reasoning as tenant.ts itself. Callers build the index
// ONCE per page load (or whenever the registry changes: after any of the
// mutation functions above), keep the resolved `ClientKeyIndex`, and then
// call `findClientByKey` synchronously for every tenant key they resolve
// afterwards — mirroring how `sentinelKey`/`defenderKey` are themselves
// resolved once and reused as plain strings downstream.

export interface ClientKeyIndex {
  /** Hashed tenant key ('sentinel:<hash16>' | 'defender:<hash16>') -> client id. */
  readonly byKey: ReadonlyMap<TenantKey, string>;
}

/** Hashes every tid and workspace of every client with tenant.ts's own functions. */
export async function buildClientKeyIndex(clients: readonly Client[] = getClients()): Promise<ClientKeyIndex> {
  const byKey = new Map<TenantKey, string>();
  for (const client of clients) {
    for (const tid of client.defenderTids) byKey.set(await defenderKey(tid), client.id);
    for (const ws of client.sentinelWorkspaces) byKey.set(await sentinelKey(ws), client.id);
  }
  return { byKey };
}

/** The client declaring `key` in a previously built index, if any. Never resolves `'unknown'`. */
export function findClientByKey(key: TenantKey, index: ClientKeyIndex): Client | undefined {
  if (isUnknownTenantKey(key)) return undefined;
  const clientId = index.byKey.get(key);
  return clientId ? getClient(clientId) : undefined;
}
