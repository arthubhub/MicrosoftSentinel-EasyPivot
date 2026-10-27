import type { Client } from '../types.ts';
import { CASES } from '../config.ts';
import { addClient, getClients } from './clients.ts';
import { log } from './log.ts';

/**
 * Client-registry export / import (N2 "Import / export du référentiel",
 * phase 5d): `{ format: 'easypivot-clients', version: 1, clients }`, a JSON
 * file SEPARATE from any case export, "utile pour passer d'un navigateur à
 * l'autre".
 *
 * ── Why this is not in `core/case-export.ts` ──
 * This file is the one place in the product, besides `core/clients.ts`
 * itself, that deliberately handles PLAINTEXT `tid`s and workspace
 * resourceIds: carrying them to another browser is the entire point. A case
 * export must never be able to do that, so the two live in different
 * modules and `core/case-export.ts` has no import of `core/clients.ts` at
 * all - see its header. Keeping the split means N2's acceptance criterion
 * ("le JSON d'export d'un cas ne contient aucun `tid`, resourceId ni nom de
 * workspace en clair") is enforced by the module graph, not by review.
 *
 * ── The warning is the caller's job, and must come FIRST ──
 * N2 requires the export to carry an "avertissement « contient des
 * identifiants de tenants »". `ui/panel/settings-view.ts` shows it as a
 * persistent hint next to the button AND as a confirmation BEFORE
 * `buildClientsExport()` is ever called, so no file is produced by a
 * mis-click. Nothing here writes a file or touches the clipboard: this
 * module only builds and validates values.
 *
 * ── Nothing here is logged ──
 * `core/clients.ts`'s own rule: counts only, never a name, a `tid` or a
 * resourceId. Same discipline below.
 */

export const CLIENTS_EXPORT_FORMAT = 'easypivot-clients';
export const CLIENTS_EXPORT_VERSION = 1;

export interface ClientsExport {
  readonly format: typeof CLIENTS_EXPORT_FORMAT;
  readonly version: typeof CLIENTS_EXPORT_VERSION;
  /** Not in N2's literal shape; added for parity with the case export's own header. */
  readonly exportedAt: number;
  readonly clients: readonly Client[];
}

/** The registry as it stands, in clear text, by design. Never throws. */
export function buildClientsExport(): ClientsExport {
  let clients: readonly Client[] = [];
  try {
    clients = getClients();
  } catch (err) {
    log.error('clients-export: could not read the registry', err);
  }
  log.debug('clients-export: built', { totalClients: clients.length });
  return {
    format: CLIENTS_EXPORT_FORMAT,
    version: CLIENTS_EXPORT_VERSION,
    exportedAt: Date.now(),
    clients,
  };
}

// ── Import ──

export type ClientsImportRefusalCode =
  | 'empty'
  | 'too-large'
  | 'not-json'
  | 'not-an-object'
  | 'wrong-format'
  | 'unsupported-version'
  | 'no-clients';

export interface ClientsImportRefusal {
  readonly code: ClientsImportRefusalCode;
  readonly detail?: string;
}

export type ClientsImportParseResult =
  | { readonly ok: true; readonly clients: readonly Client[]; readonly dropped: number }
  | { readonly ok: false; readonly refusal: ClientsImportRefusal };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Shape check only - FORMAT validity (GUID, resourceId pattern) and
 * cross-client duplicates are re-checked by `core/clients.ts`'s own
 * `addClient()` in `importClients()` below, so there is exactly one
 * validator for those rules and this cannot drift from it.
 */
function sanitizeClient(v: unknown): Client | null {
  if (!isRecord(v)) return null;
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name) return null;
  const defenderTids = strArray(v.defenderTids);
  const sentinelWorkspaces = strArray(v.sentinelWorkspaces);
  if (defenderTids.length === 0 && sentinelWorkspaces.length === 0) return null;
  return {
    id: typeof v.id === 'string' ? v.id : '',
    name,
    defenderTids,
    sentinelWorkspaces,
    createdAt: typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) ? v.createdAt : Date.now(),
    ...(typeof v.notes === 'string' ? { notes: v.notes } : {}),
    ...(v.variant === 'sentinel' || v.variant === 'defender' || v.variant === 'defender-unified'
      ? { variant: v.variant }
      : {}),
  };
}

/** Same never-throw contract as `core/case-export.ts`'s `parseCaseExport()`. */
export function parseClientsExport(text: unknown): ClientsImportParseResult {
  try {
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, refusal: { code: 'empty' } };
    if (text.length > CASES.MAX_IMPORT_CHARS) {
      return { ok: false, refusal: { code: 'too-large', detail: String(text.length) } };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, refusal: { code: 'not-json' } };
    }
    if (!isRecord(raw)) return { ok: false, refusal: { code: 'not-an-object' } };
    if (raw.format !== CLIENTS_EXPORT_FORMAT) {
      return { ok: false, refusal: { code: 'wrong-format', detail: typeof raw.format === 'string' ? raw.format : '' } };
    }
    if (raw.version !== CLIENTS_EXPORT_VERSION) {
      return { ok: false, refusal: { code: 'unsupported-version', detail: String(raw.version) } };
    }

    const rawClients = Array.isArray(raw.clients) ? raw.clients : [];
    const clients = rawClients.map(sanitizeClient).filter((c): c is Client => c !== null);
    if (clients.length === 0) return { ok: false, refusal: { code: 'no-clients' } };

    log.debug('clients-export: parsed an import candidate', {
      clients: clients.length,
      dropped: rawClients.length - clients.length,
    });
    return { ok: true, clients, dropped: rawClients.length - clients.length };
  } catch (err) {
    log.error('clients-export: parse failed unexpectedly', err);
    return { ok: false, refusal: { code: 'not-json' } };
  }
}

export interface ClientsImportResult {
  readonly added: number;
  /** Refused as a duplicate: one of its tids/workspaces already belongs to a client here. */
  readonly skipped: number;
  /** Refused on format (not a GUID, not a resourceId) or an empty name. */
  readonly invalid: number;
}

/**
 * Adds every parsed client through `core/clients.ts`'s `addClient()` -
 * never by writing `shq_clients` directly, so GUID/resourceId validation
 * and the "no tid belongs to two clients" rule are the registry's own and
 * cannot be bypassed by an import.
 *
 * Consequences, by design: the imported client gets a NEW local id (ids are
 * per-browser; a case export carries no client id precisely because of
 * this), and `createdAt`/`variant` are not preserved - `addClient()` has no
 * parameter for either. `notes` is preserved.
 */
export function importClients(clients: readonly Client[]): ClientsImportResult {
  let added = 0;
  let skipped = 0;
  let invalid = 0;
  for (const client of clients) {
    try {
      const result = addClient({
        name: client.name,
        defenderTids: client.defenderTids,
        sentinelWorkspaces: client.sentinelWorkspaces,
        ...(client.notes !== undefined ? { notes: client.notes } : {}),
      });
      if (result.ok) added++;
      else if (result.reason === 'duplicate') skipped++;
      else invalid++;
    } catch (err) {
      invalid++;
      log.error('clients-export: one client could not be imported', err);
    }
  }
  log.debug('clients-export: imported', { added, skipped, invalid });
  return { added, skipped, invalid };
}
