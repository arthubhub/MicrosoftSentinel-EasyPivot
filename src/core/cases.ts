import type {
  Case,
  CellContext,
  Client,
  IndicatorId,
  PivotSnapshot,
  PivotStep,
  PlatformId,
  QueryRun,
  SystemCaseKind,
  TenantKey,
} from '../types.ts';
import { CASES, SNAPSHOTS, STORAGE_KEYS } from '../config.ts';
import { getJson, setJson, deleteKey, estimateStorageBytes } from './storage.ts';
import { buildClientKeyIndex, findClientByKey, onClientDeleted, type ClientKeyIndex } from './clients.ts';
import { UNKNOWN_KEY } from './tenant.ts';
import { buildSnapshot, sameEvent } from './investigation.ts';
import { log } from './log.ts';

/**
 * Case registry (N2 "Gestion des cas par tenant") - the module that stops
 * one customer's investigation data being visible while looking at another
 * customer's tenant. DOM-free, like every other `core/*` module.
 *
 * PRIVACY: `shq_cases` and `shq_case_<id>` NEVER hold a `tid`, a resourceId
 * or a client name - only hashed `TenantKey`s (core/tenant.ts) and opaque
 * `clientId`s. The plaintext lives solely in `shq_clients` (core/clients.ts,
 * phase 5a). Nothing here imports a plaintext value from anywhere.
 *
 * CONCURRENCY ("Chaque écriture relit l'index avant d'écrire", N2): every
 * mutation below goes through `mutateIndex()`/`mutateBody()`, which read the
 * relevant storage key FRESH and write it back with NO `await` in between -
 * a mutation function never accepts an index/body snapshot from its caller
 * and never reuses one captured before an `await`. Two tabs each calling
 * `createCase()` one after another (even if each tab separately read the
 * index earlier, e.g. to render its own case list) therefore cannot lose
 * either tab's write: each call re-reads the latest state at the moment it
 * runs, synchronously, so there is no gap in which a second tab's earlier
 * write could be overwritten by a first tab's stale copy. This is the same
 * discipline `core/clients.ts` already follows per-function; the helpers
 * below centralise it because `core/cases.ts` has many more mutations.
 * What this does NOT solve: two tabs calling `GM_setValue` on the exact same
 * storage key at the literal same instant, which would need a lock this
 * project's "no new dependency" rule has no synchronous primitive for -
 * every real call path here removes the much larger, much more likely
 * window (holding a stale in-memory copy across a render, a click, an
 * `await`), not that theoretical instant.
 *
 * LIVE PATH (5e-1): the pivot panel records snapshots/steps here
 * (`recordSnapshotInCase`, `addStepToSnapshot`) and `capture/store.ts`
 * `addRun()` stores a captured run of the active case here
 * (`appendLiveRunToCase`), so a case really holds the investigation. The
 * legacy `shq_pivot_snapshots` key is no longer written by the live path
 * (it stays on disk for the 5c migration, rule 8). Because case bodies now
 * hold customer data (run samples) written by the live path, retention must
 * reach them: `readAllCaseRuns()`/`replaceCaseRuns()`/`getClosedCaseTimes()`
 * are the hooks `capture/store.ts`'s purge uses (`retention.days`,
 * `retention.closedDays`, `maxBytes`).
 *
 * DELETION (Settings → Cases): `deleteCase`, `deleteArchivedCases` and
 * `deleteAllCases` share one routine (`removeCases`) that deletes each body
 * key FIRST, then drops the index entries and every `activeByKey` pointer to
 * them in one re-read-and-write. A body that cannot be deleted keeps its index
 * entry (still listed, still deletable) instead of becoming an orphan that no
 * UI can reach. Bodies are only reachable through the index (`GM_listValues`
 * is not declared), so a body whose index entry is already gone cannot be found.
 */

// ── Storage shapes ──
//
// `Case` (types.ts) is the PUBLIC merged view. Storage splits it in two,
// per the Annexes: `CaseIndexEntry` (no `notes`/`playbook` - lightweight,
// listed often) in `shq_cases`, and `notes`/`playbook`/snapshots/runs (heavy,
// read less often) in `shq_case_<id>`.

export interface CaseIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly clientId?: string;
  readonly tenantKeys: readonly TenantKey[];
  readonly createdAt: number;
  readonly lastAccessAt: number;
  readonly closedAt?: number;
  readonly archivedAt?: number;
  readonly tags: readonly string[];
  /** Marker of a case EasyPivot created itself; see `systemKindOf`. Optional: older data has none. */
  readonly system?: SystemCaseKind;
}

interface CasesIndex {
  readonly version: 1;
  readonly cases: readonly CaseIndexEntry[];
  readonly activeByKey: Readonly<Record<string, string>>;
}

interface CaseBody {
  readonly notes: string;
  readonly playbook?: Case['playbook'];
  readonly snapshots: readonly PivotSnapshot[];
  readonly runs: readonly QueryRun[];
}

const EMPTY_INDEX: CasesIndex = { version: 1, cases: [], activeByKey: {} };
const EMPTY_BODY: CaseBody = { notes: '', snapshots: [], runs: [] };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Defensive, field-by-field check - never trust what `JSON.parse` handed back (hard constraint 2). */
function isCaseIndexEntry(v: unknown): v is CaseIndexEntry {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    (c.clientId === undefined || typeof c.clientId === 'string') &&
    isStringArray(c.tenantKeys) &&
    typeof c.createdAt === 'number' &&
    typeof c.lastAccessAt === 'number' &&
    (c.closedAt === undefined || typeof c.closedAt === 'number') &&
    (c.archivedAt === undefined || typeof c.archivedAt === 'number') &&
    // Any string is tolerated (a value from a newer version must not drop the case);
    // `systemKindOf` only honours the values it knows.
    (c.system === undefined || typeof c.system === 'string') &&
    isStringArray(c.tags)
  );
}

/**
 * Reads `shq_cases`, degrading to an empty index on anything unexpected
 * (hard constraint 2: a corrupt value must never throw and must never break
 * the panel). A wrong top-level shape empties the whole index; one bad
 * entry in `cases[]` only drops that entry. `activeByKey` is sanitized to
 * string -> string pairs only.
 */
function readIndex(): CasesIndex {
  const raw = getJson<unknown>(STORAGE_KEYS.CASES, null);
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    (raw as Record<string, unknown>).version !== 1 ||
    !Array.isArray((raw as Record<string, unknown>).cases)
  ) {
    if (raw !== null) log.debug('cases: stored index has an unexpected shape, using an empty index');
    return EMPTY_INDEX;
  }
  const cases = ((raw as Record<string, unknown>).cases as unknown[]).filter(isCaseIndexEntry);
  const rawActive = (raw as Record<string, unknown>).activeByKey;
  const activeByKey: Record<string, string> = {};
  if (typeof rawActive === 'object' && rawActive !== null && !Array.isArray(rawActive)) {
    for (const [k, val] of Object.entries(rawActive as Record<string, unknown>)) {
      if (typeof val === 'string') activeByKey[k] = val;
    }
  }
  return { version: 1, cases, activeByKey };
}

function writeIndex(index: CasesIndex): void {
  setJson(STORAGE_KEYS.CASES, index);
}

function caseBodyKey(id: string): string {
  return `${STORAGE_KEYS.CASE_PREFIX}${id}`;
}

function isPivotSnapshotLike(v: unknown): v is PivotSnapshot {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).id === 'string';
}

function isQueryRunLike(v: unknown): v is QueryRun {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).id === 'string';
}

/** Same degrade-never-throw contract as `readIndex()`, for one case's body. */
function readBody(id: string): CaseBody {
  const raw = getJson<unknown>(caseBodyKey(id), null);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    if (raw !== null) log.debug('cases: stored case body has an unexpected shape, using an empty body', { caseId: id });
    return EMPTY_BODY;
  }
  const r = raw as Record<string, unknown>;
  return {
    notes: typeof r.notes === 'string' ? r.notes : '',
    playbook: r.playbook as Case['playbook'] | undefined,
    snapshots: Array.isArray(r.snapshots) ? r.snapshots.filter(isPivotSnapshotLike) : [],
    runs: Array.isArray(r.runs) ? r.runs.filter(isQueryRunLike) : [],
  };
}

function writeBody(id: string, body: CaseBody): void {
  setJson(caseBodyKey(id), body);
}

// ── The re-read-before-write primitive (see file header "CONCURRENCY") ──

/** Index mutation: reads fresh, lets `mutator` compute the next state + a result, writes it back. */
// Call sites PIN the type argument (`mutateIndex<CaseMutationResult>`), because
// a mutator returning a union of object literals infers T with its string
// literals WIDENED - `reason: string` instead of `reason: 'not-found'` - which
// then fails to satisfy the discriminated result union.
// The returned shape is intentionally NOT `readonly`: the mutator returns a
// union of fresh object literals at several call sites, and `readonly` in this
// parameter position blocks T's inference across that union without buying any
// safety - the object is destructured on the next line and never kept.
function mutateIndex<T>(mutator: (index: CasesIndex) => { index: CasesIndex; result: T }): T {
  const current = readIndex();
  const { index, result } = mutator(current);
  writeIndex(index);
  return result;
}

/** Body mutation: same discipline as `mutateIndex()`, scoped to one case's `shq_case_<id>`. */
function mutateBody(id: string, mutator: (body: CaseBody) => CaseBody): void {
  writeBody(id, mutator(readBody(id)));
}

function newCaseId(): string {
  return `case-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toCase(entry: CaseIndexEntry, body: CaseBody): Case {
  return {
    id: entry.id,
    name: entry.name,
    clientId: entry.clientId,
    tenantKeys: entry.tenantKeys,
    createdAt: entry.createdAt,
    lastAccessAt: entry.lastAccessAt,
    closedAt: entry.closedAt,
    archivedAt: entry.archivedAt,
    tags: entry.tags,
    ...(entry.system !== undefined ? { system: entry.system } : {}),
    notes: body.notes,
    playbook: body.playbook,
  };
}

// ── Reads ──

/** Every stored case entry, archived included - callers almost always want `listVisibleCases()` instead. */
export function getCaseIndexEntries(): readonly CaseIndexEntry[] {
  return readIndex().cases;
}

/** Non-archived cases (N2 "archiver: masqué de la liste"). Still open+closed cases both included. */
export function listVisibleCases(): readonly CaseIndexEntry[] {
  return getCaseIndexEntries().filter((c) => c.archivedAt === undefined);
}

export function getCase(id: string): Case | undefined {
  const entry = getCaseIndexEntries().find((c) => c.id === id);
  return entry ? toCase(entry, readBody(id)) : undefined;
}

export function getCaseSnapshots(id: string): readonly PivotSnapshot[] {
  return readBody(id).snapshots;
}

export function getCaseRuns(id: string): readonly QueryRun[] {
  return readBody(id).runs;
}

/**
 * The case currently remembered for `key` (`shq_cases.activeByKey`), without
 * re-running the active-case rule - synchronous, for call sites that already
 * know resolution ran at load/key-change time (W2's pivot guard, N2
 * "cloisonnement"). Use `resolveActiveCaseForKey()` instead when the rule
 * itself needs to (re)run.
 */
export function getActiveCaseForKey(key: TenantKey): Case | undefined {
  const index = readIndex();
  const caseId = index.activeByKey[key];
  if (!caseId) return undefined;
  const entry = index.cases.find((c) => c.id === caseId);
  return entry ? toCase(entry, readBody(caseId)) : undefined;
}

// ── The single partitioning function (N2 "Cloisonnement") ──
//
// Every view that lists cases - panel, journal, graph, report (N3, phases
// 5e/5f) - MUST go through this predicate instead of re-deriving "does this
// case belong here" at each call site. `ui/case-bar.ts`'s case switcher is
// the one consumer wired up in this phase; 5e/5f are expected to call
// `listCasesInScope()` too, not reimplement the check.

export interface CaseScope {
  readonly key: TenantKey;
  readonly clientId?: string;
}

/** True if `entry` belongs in `scope`: same client, or the exact tenant key. */
export function isCaseInScope(entry: CaseIndexEntry, scope: CaseScope): boolean {
  if (scope.clientId !== undefined && entry.clientId === scope.clientId) return true;
  return entry.tenantKeys.includes(scope.key);
}

/** Visible (non-archived) cases matching `scope`, through `isCaseInScope()` alone. */
export function listCasesInScope(scope: CaseScope): readonly Case[] {
  return listVisibleCases()
    .filter((e) => isCaseInScope(e, scope))
    .map((e) => toCase(e, readBody(e.id)));
}

/**
 * Every case matching `scope` INCLUDING archived ones (Settings → Cases: an
 * archived case is hidden everywhere else but must stay deletable). Same
 * `isCaseInScope()` predicate - no second partitioning rule.
 */
export function listAllCasesInScope(scope: CaseScope): readonly CaseIndexEntry[] {
  return getCaseIndexEntries().filter((e) => isCaseInScope(e, scope));
}

// ── Pivot guard (N2 "Un pivot est refusé si le cas actif ne couvre pas la clé courante") ──

export type PivotRefusalReason = 'no-active-case' | 'key-not-covered';

/** Never throws; logs the refusal (id only, never the case name or the key - hard constraint 6). */
export function checkPivotAllowed(
  activeCase: Case | undefined,
  key: TenantKey,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: PivotRefusalReason } {
  if (!activeCase) {
    log.warn('cases: pivot refused, no active case for the current key');
    return { allowed: false, reason: 'no-active-case' };
  }
  if (!activeCase.tenantKeys.includes(key)) {
    log.warn('cases: pivot refused, active case does not cover the current key', { caseId: activeCase.id });
    return { allowed: false, reason: 'key-not-covered' };
  }
  return { allowed: true };
}

/**
 * Names stored in `Case.name` by the system cases. They are DATA, not UI
 * chrome: they stay in French exactly as older versions wrote them, so cases
 * already on disk keep parsing (rule 8). The UI never prints them directly -
 * `ui/case-name.ts` maps `systemKindOf()` to a translated label.
 */
export const UNASSIGNED_CASE_NAME = 'Non attribué';
/** Destination case of the pre-case history migration (`core/migration.ts`). */
export const MIGRATION_CASE_NAME = 'Historique avant cas';

/**
 * Which system case `c` is, if any. Pure (no `t()`, no storage).
 * - New cases carry the explicit `system` marker: authoritative.
 * - Cases stored BEFORE the marker existed are recognised by the legacy name:
 *   the unassigned one additionally needs `tenantKeys` to be exactly
 *   `['unknown']` (so an ordinary case a user merely named "Non attribué" for a
 *   real tenant is not translated); the migration one needs the exact name.
 * `renameCase()` drops the marker, so a user's rename always shows as typed.
 * Known limit: a legacy migration case a user created BY HAND with that exact
 * name is indistinguishable from the real one.
 */
export function systemKindOf(c: Pick<CaseIndexEntry, 'name' | 'tenantKeys' | 'system'>): SystemCaseKind | undefined {
  if (c.system === 'unassigned' || c.system === 'migration') return c.system;
  if (c.name === UNASSIGNED_CASE_NAME && c.tenantKeys.length === 1 && c.tenantKeys[0] === UNKNOWN_KEY) return 'unassigned';
  if (c.name === MIGRATION_CASE_NAME) return 'migration';
  return undefined;
}

// ── The active-case rule (N2 "Règle de choix du cas actif") ──
//
// Async because step 2 needs `core/clients.ts`'s key -> client index, itself
// async (`crypto.subtle`, see clients.ts's own doc comment) - there is no
// honest synchronous version of this rule. Everything AFTER that one
// `await` is synchronous (goes through `mutateIndex()`), so the re-read
// discipline above still holds for the write this function performs.

export type ActiveCaseBranch = 'remembered' | 'client-open-case' | 'key-open-case';

export type ActiveCaseResolution =
  | { readonly kind: 'active'; readonly case: Case; readonly client?: Client; readonly branch: ActiveCaseBranch }
  | { readonly kind: 'offer-new-case-for-client'; readonly client: Client }
  /** A REAL tenant key that has no client and no open case yet: the user decides where its data is filed. */
  | { readonly kind: 'offer-unknown-tenant' }
  /** The tenant key itself could not be read (`UNKNOWN_KEY`) and no open case covers it. Nothing is created: see `ensureUnassignedCase`. */
  | { readonly kind: 'unreadable-tenant' };

function isOpen(entry: CaseIndexEntry): boolean {
  return entry.closedAt === undefined && entry.archivedAt === undefined;
}

function mostRecent(entries: readonly CaseIndexEntry[]): CaseIndexEntry | undefined {
  return entries.reduce<CaseIndexEntry | undefined>(
    (best, e) => (!best || e.lastAccessAt > best.lastAccessAt ? e : best),
    undefined,
  );
}

/**
 * Runs the four-branch rule for `key` (N2, points 1-4) and persists its
 * outcome: `activeByKey[key]` is kept in sync, and a case chosen via the
 * client branch gains `key` in its `tenantKeys` if it did not already cover
 * it - "un cas peut couvrir plusieurs clés quand elles appartiennent au même
 * client" is exactly this: the first time a client's case is resolved for a
 * second key, coverage grows to include it.
 *
 * `clientIndex` lets a caller that already built one (once per load, per
 * `core/clients.ts`'s own guidance) skip rebuilding it; omitted, this
 * builds a fresh one - cheap (local data only, no network).
 */
export async function resolveActiveCaseForKey(key: TenantKey, clientIndex?: ClientKeyIndex): Promise<ActiveCaseResolution> {
  const index = clientIndex ?? (await buildClientKeyIndex());
  const client = findClientByKey(key, index);

  return mutateIndex<ActiveCaseResolution>((casesIndex) => {
    const candidates = client
      ? casesIndex.cases.filter((c) => c.clientId === client.id && isOpen(c))
      : casesIndex.cases.filter((c) => c.tenantKeys.includes(key) && isOpen(c));

    const rememberedId = casesIndex.activeByKey[key];
    const remembered = rememberedId ? candidates.find((c) => c.id === rememberedId) : undefined;
    const chosen = remembered ?? mostRecent(candidates);

    if (!chosen) {
      const hadStale = key in casesIndex.activeByKey;
      const activeByKey = { ...casesIndex.activeByKey };
      if (hadStale) delete activeByKey[key];
      // N2 point 4 (unreadable tenant -> pivot ALLOWED, filed in an unassigned
      // case) is honoured LAZILY by `ensureUnassignedCase()`, called when a pivot
      // is actually launched - resolving (page load, panel open) never creates
      // a case, or every load of every page would leave one behind.
      const unreadable = key === UNKNOWN_KEY && !client;
      const branch = client ? 'offer-new-case-for-client' : unreadable ? 'unreadable-tenant' : 'offer-unknown-tenant';
      log.info('cases: active-case rule resolved', { branch });
      return {
        index: hadStale ? { ...casesIndex, activeByKey } : casesIndex,
        result: client
          ? { kind: 'offer-new-case-for-client', client }
          : unreadable
            ? { kind: 'unreadable-tenant' }
            : { kind: 'offer-unknown-tenant' },
      };
    }

    const tenantKeys = chosen.tenantKeys.includes(key) ? chosen.tenantKeys : [...chosen.tenantKeys, key];
    const updated: CaseIndexEntry = { ...chosen, tenantKeys, lastAccessAt: Date.now() };
    const cases = casesIndex.cases.map((c) => (c.id === chosen.id ? updated : c));
    const activeByKey = { ...casesIndex.activeByKey, [key]: chosen.id };
    const branch: ActiveCaseBranch = remembered ? 'remembered' : client ? 'client-open-case' : 'key-open-case';
    log.info('cases: active-case rule resolved', { branch, caseId: chosen.id });

    return {
      index: { ...casesIndex, cases, activeByKey },
      result: { kind: 'active', case: toCase(updated, readBody(chosen.id)), client, branch },
    };
  });
}

/**
 * Lazy provisioning of the unassigned case (N2 point 4: an unreadable tenant
 * key still ALLOWS a pivot, filed in a « Non attribué » case). Called by the
 * pivot path when it launches a pivot under `UNKNOWN_KEY` with no active case,
 * never by the resolution rule. Reuses an open case that already covers
 * `UNKNOWN_KEY` (the remembered one first, else the most recent) and only
 * creates the system case when there is none. One synchronous read-modify-write.
 */
export function ensureUnassignedCase(): Case {
  return mutateIndex<Case>((index) => {
    const candidates = index.cases.filter((c) => c.tenantKeys.includes(UNKNOWN_KEY) && isOpen(c));
    const rememberedId = index.activeByKey[UNKNOWN_KEY];
    const chosen = candidates.find((c) => c.id === rememberedId) ?? mostRecent(candidates);
    if (chosen) {
      const updated: CaseIndexEntry = { ...chosen, lastAccessAt: Date.now() };
      return {
        index: {
          ...index,
          cases: index.cases.map((c) => (c.id === chosen.id ? updated : c)),
          activeByKey: { ...index.activeByKey, [UNKNOWN_KEY]: chosen.id },
        },
        result: toCase(updated, readBody(chosen.id)),
      };
    }
    const now = Date.now();
    const entry: CaseIndexEntry = {
      id: newCaseId(),
      name: UNASSIGNED_CASE_NAME,
      tenantKeys: [UNKNOWN_KEY],
      createdAt: now,
      lastAccessAt: now,
      tags: [],
      system: 'unassigned',
    };
    log.info('cases: provisioned the unassigned case for a pivot under an unreadable tenant key', { caseId: entry.id });
    return {
      index: { ...index, cases: [...index.cases, entry], activeByKey: { ...index.activeByKey, [UNKNOWN_KEY]: entry.id } },
      result: toCase(entry, EMPTY_BODY),
    };
  });
}

// ── Actions on a case (N2 "Actions sur un cas") ──

export type CaseMutationReason = 'empty-name' | 'not-found' | 'closed';
export type CaseMutationResult = { readonly ok: true; readonly case: Case } | { readonly ok: false; readonly reason: CaseMutationReason };

export interface CreateCaseInput {
  readonly name: string;
  readonly clientId?: string;
  readonly tenantKeys: readonly TenantKey[];
  /** Set only by EasyPivot's own provisioning (migration); see `systemKindOf`. */
  readonly system?: SystemCaseKind;
}

/** Creates a case and makes it active for every key it already covers. */
export function createCase(input: CreateCaseInput): CaseMutationResult {
  const name = input.name.trim();
  if (!name) return { ok: false, reason: 'empty-name' };
  const now = Date.now();
  const entry: CaseIndexEntry = {
    id: newCaseId(),
    name,
    clientId: input.clientId,
    tenantKeys: [...new Set(input.tenantKeys)],
    createdAt: now,
    lastAccessAt: now,
    tags: [],
    ...(input.system !== undefined ? { system: input.system } : {}),
  };
  return mutateIndex<CaseMutationResult>((index) => {
    const activeByKey = { ...index.activeByKey };
    for (const key of entry.tenantKeys) activeByKey[key] = entry.id;
    log.info('cases: created', { caseId: entry.id, totalCases: index.cases.length + 1 });
    return {
      index: { ...index, cases: [...index.cases, entry], activeByKey },
      result: { ok: true, case: toCase(entry, EMPTY_BODY) },
    };
  });
}

export function renameCase(id: string, name: string): CaseMutationResult {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'empty-name' };
  return mutateIndex<CaseMutationResult>((index) => {
    const existing = index.cases.find((c) => c.id === id);
    if (!existing) return { index, result: { ok: false, reason: 'not-found' } };
    // A rename is the user taking the name over: the system marker goes, so the
    // new name is shown as typed instead of the translated system label.
    const { system: _dropped, ...rest } = existing;
    const entry: CaseIndexEntry = { ...rest, name: trimmed };
    const cases = index.cases.map((c) => (c.id === id ? entry : c));
    log.info('cases: renamed', { caseId: id });
    return { index: { ...index, cases }, result: { ok: true, case: toCase(entry, readBody(id)) } };
  });
}

/** `clientId: undefined` detaches - same semantics as `core/clients.ts` deleting a client clearing it below. */
export function attachCaseToClient(id: string, clientId: string | undefined): CaseMutationResult {
  return mutateIndex<CaseMutationResult>((index) => {
    const existing = index.cases.find((c) => c.id === id);
    if (!existing) return { index, result: { ok: false, reason: 'not-found' } };
    const entry: CaseIndexEntry = { ...existing, clientId };
    const cases = index.cases.map((c) => (c.id === id ? entry : c));
    log.info('cases: client attachment changed', { caseId: id, hasClient: clientId !== undefined });
    return { index: { ...index, cases }, result: { ok: true, case: toCase(entry, readBody(id)) } };
  });
}

/**
 * Explicit "basculer" (switch): the chosen case becomes active for `key`,
 * gaining it in `tenantKeys` if it did not already cover it - same coverage
 * growth as the rule itself (`resolveActiveCaseForKey`), because switching
 * IS the user overriding the rule's own choice.
 */
export function switchActiveCase(key: TenantKey, caseId: string): CaseMutationResult {
  return mutateIndex<CaseMutationResult>((index) => {
    const existing = index.cases.find((c) => c.id === caseId);
    if (!existing) return { index, result: { ok: false, reason: 'not-found' } };
    const tenantKeys = existing.tenantKeys.includes(key) ? existing.tenantKeys : [...existing.tenantKeys, key];
    const entry: CaseIndexEntry = { ...existing, tenantKeys, lastAccessAt: Date.now() };
    const cases = index.cases.map((c) => (c.id === caseId ? entry : c));
    const activeByKey = { ...index.activeByKey, [key]: caseId };
    log.info('cases: switched active case', { caseId });
    return { index: { ...index, cases, activeByKey }, result: { ok: true, case: toCase(entry, readBody(caseId)) } };
  });
}

/** Read-only afterwards (hard constraint 3): `appendSnapshotToCase`/`appendRunToCase` refuse once this is set. Idempotent. */
export function closeCase(id: string): CaseMutationResult {
  return mutateIndex<CaseMutationResult>((index) => {
    const existing = index.cases.find((c) => c.id === id);
    if (!existing) return { index, result: { ok: false, reason: 'not-found' } };
    if (existing.closedAt !== undefined) return { index, result: { ok: true, case: toCase(existing, readBody(id)) } };
    const entry = { ...existing, closedAt: Date.now() };
    const cases = index.cases.map((c) => (c.id === id ? entry : c));
    log.info('cases: closed', { caseId: id });
    return { index: { ...index, cases }, result: { ok: true, case: toCase(entry, readBody(id)) } };
  });
}

/** Hidden from `listVisibleCases()` (not deleted - see `deleteCase`/`deleteArchivedCases`). Idempotent. */
export function archiveCase(id: string): CaseMutationResult {
  return mutateIndex<CaseMutationResult>((index) => {
    const existing = index.cases.find((c) => c.id === id);
    if (!existing) return { index, result: { ok: false, reason: 'not-found' } };
    if (existing.archivedAt !== undefined) return { index, result: { ok: true, case: toCase(existing, readBody(id)) } };
    const entry = { ...existing, archivedAt: Date.now() };
    const cases = index.cases.map((c) => (c.id === id ? entry : c));
    log.info('cases: archived', { caseId: id });
    return { index: { ...index, cases }, result: { ok: true, case: toCase(entry, readBody(id)) } };
  });
}

// ── Deletion (Settings → Cases) ──
//
// Confirmation is the caller's job (UI), same contract as `core/clients.ts`'s
// `deleteClient`. None of these throw; counts only are logged (never a name).

export interface RemovalCounts {
  readonly cases: number;
  readonly snapshots: number;
  readonly runs: number;
  /** Cases whose body could not be deleted: they stay in the index. */
  readonly failed: number;
  /** `activeByKey` pointers that pointed at a removed case and were dropped. */
  readonly pointersCleared: number;
}

const NO_REMOVAL: RemovalCounts = { cases: 0, snapshots: 0, runs: 0, failed: 0, pointersCleared: 0 };

/**
 * Removes every case `select` accepts: body key first, then ONE fresh
 * read-modify-write of the index dropping those entries and any
 * `activeByKey` pointer to them. Other cases' bodies are never read for
 * writing, so they stay byte-identical. Never throws.
 */
function removeCases(select: (entry: CaseIndexEntry) => boolean): RemovalCounts & { readonly error: boolean } {
  try {
    const removed = new Set<string>();
    let snapshots = 0;
    let runs = 0;
    let failed = 0;
    for (const victim of readIndex().cases.filter(select)) {
      try {
        const body = readBody(victim.id);
        deleteKey(caseBodyKey(victim.id));
        snapshots += body.snapshots.length;
        runs += body.runs.length;
        removed.add(victim.id);
      } catch (err) {
        failed++;
        log.error('cases: could not delete a case body, its entry is kept', err);
      }
    }
    let pointersCleared = 0;
    if (removed.size > 0) {
      pointersCleared = mutateIndex<number>((index) => {
        const activeByKey: Record<string, string> = {};
        let cleared = 0;
        for (const [key, caseId] of Object.entries(index.activeByKey)) {
          if (removed.has(caseId)) cleared++;
          else activeByKey[key] = caseId;
        }
        return { index: { ...index, cases: index.cases.filter((c) => !removed.has(c.id)), activeByKey }, result: cleared };
      });
    }
    log.info('cases: removed', { cases: removed.size, snapshots, runs, failed, pointersCleared });
    return { cases: removed.size, snapshots, runs, failed, pointersCleared, error: false };
  } catch (err) {
    log.error('cases: removal failed', err);
    return { ...NO_REMOVAL, error: true };
  }
}

export type DeleteCaseResult =
  | { readonly deleted: true; readonly snapshots: number; readonly runs: number; readonly wasActive: boolean }
  | { readonly deleted: false; readonly reason: 'not-found' | 'error' };

/** Deletes one case (body, index entry, active pointers). Unknown id -> `deleted: false`, nothing touched. */
export function deleteCase(id: string): DeleteCaseResult {
  if (!readIndex().cases.some((c) => c.id === id)) return { deleted: false, reason: 'not-found' };
  const r = removeCases((c) => c.id === id);
  if (r.cases === 0) return { deleted: false, reason: r.error || r.failed > 0 ? 'error' : 'not-found' };
  return { deleted: true, snapshots: r.snapshots, runs: r.runs, wasActive: r.pointersCleared > 0 };
}

/** Deletes every archived case (any client). */
export function deleteArchivedCases(): RemovalCounts {
  const { error: _e, ...counts } = removeCases((c) => c.archivedAt !== undefined);
  return counts;
}

/** Deletes every case, any client, system cases included. The caller adds the capture buffers (`capture/store.ts`). */
export function deleteAllCases(): RemovalCounts {
  const { error: _e, ...counts } = removeCases(() => true);
  return counts;
}

export interface CaseTotals {
  readonly cases: number;
  readonly archived: number;
  readonly snapshots: number;
  readonly runs: number;
}

/** Counts across every case of every client - numbers only, for confirmation texts. */
export function getCaseTotals(): CaseTotals {
  let archived = 0;
  let snapshots = 0;
  let runs = 0;
  const entries = getCaseIndexEntries();
  for (const e of entries) {
    if (e.archivedAt !== undefined) archived++;
    const body = readBody(e.id);
    snapshots += body.snapshots.length;
    runs += body.runs.length;
  }
  return { cases: entries.length, archived, snapshots, runs };
}

export interface CaseStats {
  readonly snapshots: number;
  readonly runs: number;
  /** Approximate: byte length of the stored JSON string of the body. */
  readonly bytes: number;
}

export function getCaseStats(id: string): CaseStats {
  const body = readBody(id);
  return { snapshots: body.snapshots.length, runs: body.runs.length, bytes: estimateStorageBytes([caseBodyKey(id)]) };
}

export function setCaseNotes(id: string, notes: string): CaseMutationResult {
  const entry = getCaseIndexEntries().find((c) => c.id === id);
  if (!entry) return { ok: false, reason: 'not-found' };
  if (entry.closedAt !== undefined) {
    log.warn('cases: notes update refused, case is closed', { caseId: id });
    return { ok: false, reason: 'closed' };
  }
  mutateBody(id, (body) => ({ ...body, notes }));
  log.info('cases: notes updated', { caseId: id });
  return { ok: true, case: toCase(entry, readBody(id)) };
}

/**
 * Replaces the tag list (trimmed, de-duplicated, empties dropped). Added in
 * 5d because `core/case-export.ts`'s import has to RESTORE the tags an
 * export carried - without this they would be silently dropped on every
 * import - and because a masked import is marked with a tag. Tags live in
 * the index (not the body), hence `mutateIndex`. Same read-only contract as
 * `setCaseNotes`: refused on a closed case.
 */
export function setCaseTags(id: string, tags: readonly string[]): CaseMutationResult {
  const cleaned = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  return mutateIndex<CaseMutationResult>((index) => {
    const existing = index.cases.find((c) => c.id === id);
    if (!existing) return { index, result: { ok: false, reason: 'not-found' } };
    if (existing.closedAt !== undefined) {
      log.warn('cases: tags update refused, case is closed', { caseId: id });
      return { index, result: { ok: false, reason: 'closed' } };
    }
    const entry: CaseIndexEntry = { ...existing, tags: cleaned };
    const cases = index.cases.map((c) => (c.id === id ? entry : c));
    log.info('cases: tags updated', { caseId: id, tags: cleaned.length });
    return { index: { ...index, cases }, result: { ok: true, case: toCase(entry, readBody(id)) } };
  });
}

// ── Appending capture data (hard constraint 3: closed = genuinely read-only) ──

export type AppendReason = 'not-found' | 'closed';
export type AppendResult = { readonly ok: true } | { readonly ok: false; readonly reason: AppendReason };

function findEntry(id: string): CaseIndexEntry | undefined {
  return getCaseIndexEntries().find((c) => c.id === id);
}

/** Open case entry, or the typed refusal - the one place the closed check lives for appends. */
function writableEntry(caseId: string): { readonly entry: CaseIndexEntry } | { readonly refusal: AppendReason } {
  const entry = findEntry(caseId);
  if (!entry) return { refusal: 'not-found' };
  if (entry.closedAt !== undefined) return { refusal: 'closed' };
  return { entry };
}

export function appendSnapshotToCase(caseId: string, snapshot: PivotSnapshot): AppendResult {
  const entry = findEntry(caseId);
  if (!entry) return { ok: false, reason: 'not-found' };
  if (entry.closedAt !== undefined) {
    log.warn('cases: snapshot append refused, case is closed', { caseId });
    return { ok: false, reason: 'closed' };
  }
  mutateBody(caseId, (body) => ({
    ...body,
    snapshots: [snapshot, ...body.snapshots].slice(0, CASES.MAX_SNAPSHOTS_PER_CASE),
  }));
  touchLastAccess(caseId);
  log.info('cases: snapshot appended', { caseId });
  return { ok: true };
}

export function appendRunToCase(caseId: string, run: QueryRun): AppendResult {
  const entry = findEntry(caseId);
  if (!entry) return { ok: false, reason: 'not-found' };
  if (entry.closedAt !== undefined) {
    log.warn('cases: run append refused, case is closed', { caseId });
    return { ok: false, reason: 'closed' };
  }
  mutateBody(caseId, (body) => ({ ...body, runs: [run, ...body.runs] }));
  touchLastAccess(caseId);
  log.info('cases: run appended', { caseId });
  return { ok: true };
}

function touchLastAccess(caseId: string): void {
  mutateIndex((index) => {
    const cases = index.cases.map((c) => (c.id === caseId ? { ...c, lastAccessAt: Date.now() } : c));
    return { index: { ...index, cases }, result: undefined };
  });
}

// ── Live path (5e-1): what the pivot panel and the capture store call ──
//
// Everything below re-reads the body at the moment it writes (one synchronous
// read-modify-write, no await in between) and refuses a closed case.

/** Body mutation that also returns a value; same re-read discipline as `mutateBody`. */
function mutateBodyWith<T>(id: string, mutator: (body: CaseBody) => { body: CaseBody; result: T }): T {
  const { body, result } = mutator(readBody(id));
  writeBody(id, body);
  return result;
}

/**
 * Parent link for a new snapshot (N3: "no guessing"). Only when the clicked
 * cell was matched against a captured run (`source: 'capture'`, `runId`) AND
 * that run is stored in THIS case AND it is linked to a snapshot. A missing
 * runId, an unknown runId, or a run with no `snapshotId` (a manual query) =>
 * no link: the snapshot is a root. Timing is never consulted.
 */
function resolveParentLink(
  body: CaseBody,
  ctx: CellContext,
): { readonly parentSnapshotId: string; readonly parentRunId: string } | undefined {
  if (ctx.source !== 'capture' || !ctx.runId) return undefined;
  const run = body.runs.find((r) => r.id === ctx.runId);
  if (!run?.snapshotId) return undefined;
  return { parentSnapshotId: run.snapshotId, parentRunId: run.id };
}

export type RecordSnapshotResult =
  | { readonly ok: true; readonly snapshot: PivotSnapshot; readonly created: boolean }
  | { readonly ok: false; readonly reason: AppendReason };

/**
 * Case-level equivalent of `core/investigation.ts`'s `recordSnapshot`: the
 * same row from the same source query reuses (and moves to the front) the
 * existing snapshot - same `sameEvent` - otherwise a new one is built, linked
 * to its parent when the rule above allows, and prepended (capped at
 * `MAX_SNAPSHOTS_PER_CASE`; a dropped parent just leaves an orphan the graph
 * treats as a root).
 */
export function recordSnapshotInCase(
  caseId: string,
  ctx: CellContext,
  sourceQuery: string,
  platform: PlatformId,
): RecordSnapshotResult {
  const w = writableEntry(caseId);
  if ('refusal' in w) {
    log.warn('cases: snapshot record refused', { caseId, reason: w.refusal });
    return { ok: false, reason: w.refusal };
  }
  const source = sourceQuery.length > SNAPSHOTS.MAX_SOURCE_CHARS ? '' : sourceQuery;

  const result = mutateBodyWith<{ snapshot: PivotSnapshot; created: boolean }>(caseId, (body) => {
    const existing = body.snapshots.find((s) => sameEvent(s, ctx, source));
    if (existing) {
      return {
        body: { ...body, snapshots: [existing, ...body.snapshots.filter((s) => s.id !== existing.id)] },
        result: { snapshot: existing, created: false },
      };
    }
    const link = resolveParentLink(body, ctx);
    const snapshot: PivotSnapshot = { ...buildSnapshot(ctx, source, platform), caseId, ...(link ?? {}) };
    return {
      body: { ...body, snapshots: [snapshot, ...body.snapshots].slice(0, CASES.MAX_SNAPSHOTS_PER_CASE) },
      result: { snapshot, created: true },
    };
  });
  touchLastAccess(caseId);
  log.info('cases: snapshot recorded', { caseId, created: result.created, linked: result.snapshot.parentSnapshotId !== undefined });
  return { ok: true, snapshot: result.snapshot, created: result.created };
}

export type StepResult = { readonly ok: true } | { readonly ok: false; readonly reason: AppendReason | 'snapshot-not-found' };

/** Case-level equivalent of `core/investigation.ts`'s `addStep`. */
export function addStepToSnapshot(
  caseId: string,
  snapshotId: string,
  step: { readonly ruleId: string; readonly value: string; readonly indicator: IndicatorId },
): StepResult {
  const w = writableEntry(caseId);
  if ('refusal' in w) {
    log.warn('cases: step refused', { caseId, reason: w.refusal });
    return { ok: false, reason: w.refusal };
  }
  const full: PivotStep = { at: Date.now(), ...step };
  const found = mutateBodyWith<boolean>(caseId, (body) => {
    if (!body.snapshots.some((s) => s.id === snapshotId)) return { body, result: false };
    return {
      body: {
        ...body,
        snapshots: body.snapshots.map((s) => (s.id === snapshotId ? { ...s, steps: [...s.steps, full] } : s)),
      },
      result: true,
    };
  });
  if (!found) {
    log.warn('cases: step not added, snapshot is not in this case', { caseId });
    return { ok: false, reason: 'snapshot-not-found' };
  }
  touchLastAccess(caseId);
  return { ok: true };
}

// ── Note and pinned evidence (5e-2) ──
//
// Same discipline as `addStepToSnapshot`: `writableEntry` refuses a closed or
// unknown case, then ONE synchronous read-modify-write. Both fields are
// customer data (masked by `core/case-export.ts`), so only counts are logged.

export type SnapshotEditReason = AppendReason | 'snapshot-not-found' | 'out-of-range' | 'empty-row' | 'limit' | 'error';

export type SetNoteResult = { readonly ok: true; readonly cleared: boolean } | { readonly ok: false; readonly reason: SnapshotEditReason };
export type PinRowResult =
  | { readonly ok: true; readonly added: boolean; readonly count: number }
  | { readonly ok: false; readonly reason: SnapshotEditReason };
export type UnpinRowResult = { readonly ok: true; readonly count: number } | { readonly ok: false; readonly reason: SnapshotEditReason };

/** Applies `edit` to one snapshot of an open case; `undefined` from `edit` = nothing to change. Never throws. */
function editSnapshot<T>(
  caseId: string,
  snapshotId: string,
  op: string,
  edit: (snap: PivotSnapshot) => { readonly snap: PivotSnapshot; readonly result: T } | SnapshotEditReason,
): { readonly ok: true; readonly result: T } | { readonly ok: false; readonly reason: SnapshotEditReason } {
  try {
    const w = writableEntry(caseId);
    if ('refusal' in w) {
      log.warn(`cases: ${op} refused`, { caseId, reason: w.refusal });
      return { ok: false, reason: w.refusal };
    }
    const outcome = mutateBodyWith<{ readonly result: T } | SnapshotEditReason>(caseId, (body) => {
      const snap = body.snapshots.find((s) => s.id === snapshotId);
      if (!snap) return { body, result: 'snapshot-not-found' };
      const edited = edit(snap);
      if (typeof edited === 'string') return { body, result: edited };
      return {
        body: { ...body, snapshots: body.snapshots.map((s) => (s.id === snapshotId ? edited.snap : s)) },
        result: { result: edited.result },
      };
    });
    if (typeof outcome === 'string') {
      log.warn(`cases: ${op} not applied`, { caseId, reason: outcome });
      return { ok: false, reason: outcome };
    }
    touchLastAccess(caseId);
    return { ok: true, result: outcome.result };
  } catch (err) {
    log.error(`cases: ${op} failed`, err);
    return { ok: false, reason: 'error' };
  }
}

/** Sets the node's note (capped at `MAX_NOTE_CHARS`). Empty / whitespace-only clears the field. */
export function setSnapshotNote(caseId: string, snapshotId: string, note: string): SetNoteResult {
  const capped = typeof note === 'string' ? note.slice(0, CASES.MAX_NOTE_CHARS) : '';
  const clear = capped.trim() === '';
  const r = editSnapshot<boolean>(caseId, snapshotId, 'note update', (snap) => {
    if (clear) {
      const { note: _dropped, ...rest } = snap;
      return { snap: rest, result: true };
    }
    return { snap: { ...snap, note: capped }, result: false };
  });
  if (!r.ok) return r;
  log.info('cases: note updated', { caseId, chars: clear ? 0 : capped.length });
  return { ok: true, cleared: r.result };
}

/** Cells are truncated like a snapshot's own row (`SNAPSHOTS.MAX_CELL_CHARS`). */
function truncateRow(row: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [col, val] of Object.entries(row)) {
    const s = typeof val === 'string' ? val : String(val);
    out[col] = s.length > SNAPSHOTS.MAX_CELL_CHARS ? s.slice(0, SNAPSHOTS.MAX_CELL_CHARS) : s;
  }
  return out;
}

function sameRow(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

/**
 * Pins a row as evidence. An identical row already pinned is not added again
 * (`added: false`, still `ok`); at `MAX_PINNED_ROWS` a NEW row is refused
 * with `limit`. An empty row is refused.
 */
export function pinRowToSnapshot(caseId: string, snapshotId: string, row: Readonly<Record<string, string>>): PinRowResult {
  const cells = truncateRow(row ?? {});
  if (Object.keys(cells).length === 0) {
    log.warn('cases: pin refused, empty row', { caseId });
    return { ok: false, reason: 'empty-row' };
  }
  const r = editSnapshot<{ added: boolean; count: number }>(caseId, snapshotId, 'pin', (snap) => {
    const pinned = Array.isArray(snap.pinnedRows) ? snap.pinnedRows : [];
    if (pinned.some((p) => sameRow(p, cells))) return { snap, result: { added: false, count: pinned.length } };
    if (pinned.length >= CASES.MAX_PINNED_ROWS) return 'limit';
    return { snap: { ...snap, pinnedRows: [...pinned, cells] }, result: { added: true, count: pinned.length + 1 } };
  });
  if (!r.ok) return r;
  log.info('cases: row pinned', { caseId, added: r.result.added, pinned: r.result.count });
  return { ok: true, added: r.result.added, count: r.result.count };
}

/** Removes the pinned row at `index`; the field disappears when the last one goes. */
export function unpinRow(caseId: string, snapshotId: string, index: number): UnpinRowResult {
  const r = editSnapshot<number>(caseId, snapshotId, 'unpin', (snap) => {
    const pinned = Array.isArray(snap.pinnedRows) ? snap.pinnedRows : [];
    if (!Number.isInteger(index) || index < 0 || index >= pinned.length) return 'out-of-range';
    const rest = pinned.filter((_, i) => i !== index);
    if (rest.length === 0) {
      const { pinnedRows: _dropped, ...without } = snap;
      return { snap: without, result: 0 };
    }
    return { snap: { ...snap, pinnedRows: rest }, result: rest.length };
  });
  if (!r.ok) return r;
  log.info('cases: row unpinned', { caseId, pinned: r.result });
  return { ok: true, count: r.result };
}

/**
 * Oldest runs beyond the cap are dropped, runs NOT linked to a snapshot
 * first (a pivot-linked run carries the graph's result status).
 */
function capRuns(runs: readonly QueryRun[], cap: number): readonly QueryRun[] {
  let kept = [...runs]; // newest first
  while (kept.length > cap) {
    let victim = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].snapshotId === undefined) {
        victim = i;
        break;
      }
    }
    kept.splice(victim === -1 ? kept.length - 1 : victim, 1);
  }
  return kept;
}

/**
 * The run without its pivot link (`snapshotId` and the `ruleId` that came with
 * it). Used when the snapshot the run points at is not where the run is stored:
 * a link that crosses cases would be a dangling reference (and would show
 * another case's snapshot id inside this one).
 */
export function unlinkRun(run: QueryRun): QueryRun {
  const { snapshotId: _snapshot, ruleId: _rule, ...rest } = run;
  return rest;
}

export type LiveAppendResult =
  | { readonly ok: true; readonly run: QueryRun; readonly linkDropped: boolean }
  | { readonly ok: false; readonly reason: AppendReason };

/**
 * Stores a LIVE captured run (`capture/store.ts` `addRun`) in `caseId`:
 * prepends it, caps the list, and - when the run is linked to a snapshot of
 * this case - appends the run id to that snapshot's `runIds` in the SAME
 * write. Refuses a closed case.
 *
 * THE GUARD LIVES HERE (not in `capture/store.ts`): a run keeps `snapshotId`
 * (and `ruleId`) ONLY if that snapshot is in THIS case's body, checked against
 * the body re-read inside the same synchronous read-modify-write that stores
 * the run - so no caller can bypass it or race it. Otherwise the run is stored
 * unlinked and `linkDropped` says so; the caller gets the run as stored.
 * (`appendRunToCase` stays the plain append the migration and the import use,
 * so their output is unchanged.)
 */
export function appendLiveRunToCase(caseId: string, run: QueryRun): LiveAppendResult {
  const w = writableEntry(caseId);
  if ('refusal' in w) {
    log.warn('cases: live run append refused', { caseId, reason: w.refusal });
    return { ok: false, reason: w.refusal };
  }
  const wanted = run.snapshotId;
  const stored = mutateBodyWith<{ run: QueryRun; linkDropped: boolean }>(caseId, (body) => {
    const linked = wanted !== undefined && body.snapshots.some((s) => s.id === wanted);
    const kept = wanted === undefined || linked ? run : unlinkRun(run);
    const snapshots = linked
      ? body.snapshots.map((s) =>
          s.id === wanted && !(s.runIds ?? []).includes(run.id) ? { ...s, runIds: [...(s.runIds ?? []), run.id] } : s,
        )
      : body.snapshots;
    return {
      body: { ...body, snapshots, runs: capRuns([kept, ...body.runs.filter((r) => r.id !== run.id)], CASES.MAX_RUNS_PER_CASE) },
      result: { run: kept, linkDropped: wanted !== undefined && !linked },
    };
  });
  touchLastAccess(caseId);
  // Counts only: no id of the foreign snapshot, no value.
  log.info('cases: live run appended', { caseId, linked: stored.run.snapshotId !== undefined, linkDropped: stored.linkDropped ? 1 : 0 });
  return { ok: true, run: stored.run, linkDropped: stored.linkDropped };
}

// ── Retention hooks (5e-1): `capture/store.ts`'s purge reaches case bodies through these ──

/** Every case's stored runs, closed and archived included (retention applies to all of them). */
export function readAllCaseRuns(): Map<string, QueryRun[]> {
  const out = new Map<string, QueryRun[]>();
  for (const entry of getCaseIndexEntries()) {
    const runs = readBody(entry.id).runs;
    if (runs.length > 0) out.set(entry.id, [...runs]);
  }
  return out;
}

/** `closedAt` of every CLOSED case (archived or not): `retention.closedDays` is measured from it. */
export function getClosedCaseTimes(): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of getCaseIndexEntries()) if (entry.closedAt !== undefined) out.set(entry.id, entry.closedAt);
  return out;
}

/**
 * Replaces one case's run list (retention only: a purge may rewrite a CLOSED
 * case - dropping customer data is not "adding" to it). Re-reads the body so
 * notes/snapshots written meanwhile are kept; only `runs` is replaced.
 */
export function replaceCaseRuns(caseId: string, runs: readonly QueryRun[]): void {
  if (!findEntry(caseId)) return;
  mutateBody(caseId, (body) => ({ ...body, runs }));
}

// ── onClientDeleted hook (N2: "suppression avec confirmation (les cas restent, leur clientId est vidé)") ──
//
// `core/clients.ts` cannot clear `Case.clientId` itself (phase 5a predates
// this module) so it publishes the deleted id instead; this is the
// subscriber it was built for, wired once at module load.

function clearClientIdFromCases(clientId: string): void {
  mutateIndex((index) => {
    let cleared = 0;
    const cases = index.cases.map((c) => {
      if (c.clientId !== clientId) return c;
      cleared++;
      return { ...c, clientId: undefined };
    });
    if (cleared === 0) return { index, result: undefined };
    log.info('cases: client deleted, cleared clientId from its cases', { clearedCases: cleared });
    return { index: { ...index, cases }, result: undefined };
  });
}

onClientDeleted(clearClientIdFromCases);
