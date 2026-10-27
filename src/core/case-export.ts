import type { IndicatorId, ParsedColumn, PivotSnapshot, PivotStep, QueryRun, RunSummary, TenantKey } from '../types.ts';
import { CAPTURE_STORE, CASES, PIVOT, SNAPSHOTS } from '../config.ts';
import {
  appendRunToCase,
  appendSnapshotToCase,
  closeCase,
  createCase,
  getCase,
  getCaseRuns,
  getCaseSnapshots,
  setCaseNotes,
  setCaseTags,
  type CaseScope,
} from './cases.ts';
import { getSetting } from './settings.ts';
import { redactIndicatorValue, redactUnknown, redactValue } from './redact.ts';
import { UNKNOWN_KEY } from './tenant.ts';
import { log } from './log.ts';

/**
 * Case export / import (N2 "Export / import", phase 5d). Pure logic, no
 * DOM: `ui/panel/settings-view.ts` owns the checkbox, the Blob download and
 * the file input, and is the ONLY route this data leaves the browser by.
 *
 * ── Why this module does not import `core/clients.ts` ──
 * `core/clients.ts`'s header is explicit: "This module must never be
 * imported by a case export, a report, an issue builder or
 * `core/health.ts`'s diagnostics text." That is honoured LITERALLY here —
 * there is no import of it anywhere below, which makes N2's acceptance
 * criterion ("le JSON d'export d'un cas ne contient aucun `tid`,
 * resourceId ni nom de workspace en clair") a STRUCTURAL property rather
 * than something to re-audit field by field: the only module in the
 * product that holds those plaintext values is not reachable from here.
 * The registry's own separate export lives in `core/clients-export.ts`,
 * which is allowed to see them because that export's entire purpose is to
 * carry them to another browser, behind an explicit warning.
 *
 * The one thing the import side DOES need from the registry is "which
 * client, if any, owns these hashed keys" — and that is answered with the
 * hashed `ClientKeyIndex.byKey` map (key -> opaque client id) passed in by
 * the caller via `CaseImportScope.clientKeys`. Hashes and opaque ids only;
 * no plaintext crosses this boundary.
 *
 * ── What is masked, and what is deliberately NOT (read this before
 *    "fixing" a field) ──
 * Masking is done exclusively through `core/redact.ts` (irreversible,
 * keyless, fail-closed). There is NO second masking path in this file: the
 * only thing the functions below decide is WHICH `redact.ts` call applies
 * to which field.
 *
 * MASKED (default; cleared only by the explicit "include values" opt-in):
 *  - `case.notes`, `snapshot.sourceQuery`, `run.kqlPreview`, `run.error` —
 *    all FREE TEXT, all through `redactUnknown()`, which for any realistic
 *    multi-token content returns the opaque `***`. That is the point: a
 *    note or a KQL block cannot be masked token-by-token safely (a bare
 *    hostname is indistinguishable from an ordinary word, and KQL has three
 *    string-literal syntaxes - `@"…"`, `"…"`, `'…'`), so the whole field
 *    collapses. `redactKqlLiterals()` is deliberately NOT used here even
 *    though it exists: it masks the contents of `@"…"` literals only - the
 *    form `core/pivot.ts` itself emits - and would leave an analyst's own
 *    `where DeviceName == "DC01"` perfectly readable inside text that LOOKS
 *    masked. That is the worst possible failure mode (plausible but
 *    leaking), so the stronger whole-field collapse wins. `redactKqlLiterals`
 *    stays the right tool for 5f's report, where the KQL on display is
 *    EasyPivot-generated and must stay readable.
 *  - `snapshot.value`, `snapshot.row[*]`, `run.summary.topValues[*]`,
 *    `run.rowsSample[*][*]` — per-VALUE, through `redactUnknown()` (shape
 *    guessed, unknown shapes fail closed to `***`).
 *  - `snapshot.host` — `redactValue(…, 'device')`: the kind IS known here.
 *  - `snapshot.note` (5e-1) — free text, `redactUnknown()` (collapses to `***`).
 *  - `snapshot.pinnedRows[*][*]` (5e-1) — whole rows of customer data, every
 *    cell through `redactUnknown()`, exactly like `snapshot.row`.
 *  - `snapshot.steps[*].value` — `redactIndicatorValue(value, indicator)`:
 *    the indicator type is recorded on the step, so the type-aware mask
 *    applies instead of shape-guessing.
 *  - `run.sourceTables` / `run.summary.bySource` keys matching `/_CL$/i` —
 *    DROPPED, not masked (project rule 2): a custom-table name is itself
 *    customer-specific ("ACMELogs_CL"). Only in the masked export: when the
 *    user explicitly opts into including values she is shipping her own
 *    data knowingly, and silently rewriting her table list would break the
 *    round-trip the opt-in exists for.
 *
 * NOT masked, on purpose:
 *  - `case.name` and `case.tags`. They are the only human handle on the
 *    file, and a case the recipient cannot identify is not worth sending.
 *    This IS a judgement call with a real edge (an analyst who names a case
 *    "ACME Corp" leaks that name), so it is DISCLOSED in the export UI's
 *    hint text rather than left for the user to discover - same house rule
 *    as never filtering rules silently.
 *  - Column names, table names (non-`_CL`), rule ids, platform, statuses,
 *    row counts, durations, timestamps, `kqlHash` (a hash is not personal
 *    data - `core/redact.ts`'s own documented exemption), and the hashed
 *    `tenantKeys` themselves, which are exactly what N2 means by "les clés
 *    exportées sont les empreintes, jamais les identifiants".
 *  - `snapshot.entityName`: Defender's declared ENTITY TYPE for the column
 *    ('Ip', 'Account'), not a value.
 *  - `snapshot.caseId`, `parentSnapshotId`, `parentRunId`, `runIds` (5e-1):
 *    opaque generated ids, the graph's edges. On import they are validated
 *    against what the file actually contains (see `linkSnapshots()`): a link
 *    to an id that is not in the file is dropped, never left dangling.
 *
 * ── `case.clientId` is DROPPED (N2 design point) ──
 * The export carries `hadClient: boolean` instead of the opaque client id.
 * Nothing is lost: the client link is re-derivable at import time from the
 * hashed `tenantKeys` against the importing browser's own registry (see
 * `resolveClientId()` below), which is also the only correct answer, since
 * the same customer gets a DIFFERENT local client id in every browser. And
 * something is gained: two case exports of the same customer no longer
 * share a stable id a recipient could use to correlate them.
 *
 * ── A masked export must not come back looking like data (design point 4) ──
 * `redacted: true` is recorded IN the file; `parseCaseExport()` surfaces it;
 * the UI confirms it before importing; and the imported case is marked
 * PERMANENTLY, not just at import time - its name gains
 * `REDACTED_IMPORT_NAME_SUFFIX`, it gains the `REDACTED_IMPORT_TAG` tag, and
 * a provenance line is prepended to its notes. Without that, a colleague
 * three weeks later sees a case full of `***` and `203.0.x.x` values with
 * nothing saying those are placeholders - and `203.0.x.x` in particular
 * reads as a real address.
 *
 * ── Never throws (design point 5) ──
 * Import input is a user-chosen file. Every entry point below returns a
 * typed result; a refusal is a value, never an exception. Out-of-scope
 * cases are refused by `importCase()`, and accepting one requires calling a
 * DIFFERENT function (`importCaseAcceptingForeignKeys()`) - not flipping a
 * boolean that could default to permissive.
 */

// ── Format constants ──

export const CASE_EXPORT_FORMAT = 'easypivot-case';
export const CASE_EXPORT_VERSION = 1;

/**
 * Markers written into the IMPORTED case when the source file was masked.
 * Stored data (a case name, a tag, a note), not UI chrome, so they are
 * literal French constants and never go through `t()` - same precedent as
 * `core/cases.ts`'s `UNASSIGNED_CASE_NAME` and `MIGRATION_CASE_NAME`.
 *
 * EXPORTS CARRY THE STORED NAME. A system case ("Non attribué") is displayed
 * translated in the UI (`ui/case-name.ts`) but exported as stored, and the
 * `system` marker is not exported: a file is a record that must read the same
 * whichever language the exporting browser used. On import the case is an
 * ordinary one that `systemKindOf` re-recognises only by its legacy name + keys.
 */
export const REDACTED_IMPORT_NAME_SUFFIX = '(valeurs masquées)';
export const REDACTED_IMPORT_TAG = 'valeurs-masquées';
const REDACTED_IMPORT_NOTE =
  'Importé depuis un export masqué : les valeurs de ce cas sont des marqueurs (***, 203.0.x.x…), pas les données réelles.';

// ── Exported shapes ──

/**
 * `Case` minus `clientId` (see the header), plus `hadClient`. Field names
 * and order follow N2's own `{ format, version, exportedAt, case,
 * snapshots, runs }` shape; `redacted` is the one addition, required by
 * design point 4.
 */
export interface ExportedCase {
  readonly id: string;
  readonly name: string;
  readonly tenantKeys: readonly TenantKey[];
  readonly createdAt: number;
  readonly lastAccessAt: number;
  readonly closedAt?: number;
  readonly archivedAt?: number;
  readonly tags: readonly string[];
  readonly notes: string;
  /** The source case was attached to a client; the id itself is never exported. */
  readonly hadClient: boolean;
  readonly playbook?: {
    readonly id: string;
    readonly step: number;
    readonly done: readonly string[];
    readonly values: Readonly<Record<string, string>>;
  };
}

export interface CaseExport {
  readonly format: typeof CASE_EXPORT_FORMAT;
  readonly version: typeof CASE_EXPORT_VERSION;
  readonly exportedAt: number;
  /** `true` = values are masked placeholders. Never inferred, always read from the file. */
  readonly redacted: boolean;
  readonly case: ExportedCase;
  readonly snapshots: readonly PivotSnapshot[];
  readonly runs: readonly QueryRun[];
}

// ── Masking helpers (every one of them delegates to core/redact.ts) ──
//
// ── Why these build their output field by field instead of spreading ──
// The obvious shape for a masker is `{ ...run, value: mask(run.value) }`: short,
// and it survives a field being added to the type. That is exactly the problem.
// A spread is a BLACKLIST - it exports every field it was not told about - so
// the day a later phase adds a field carrying a value (or a run written by an
// older build is still in storage with a field since removed), the masked export
// ships it in clear and nothing complains. `npm run check` cannot catch it
// either: a passthrough field is perfectly well typed.
//
// So every mask below is a WHITELIST: it names each field it emits and drops
// everything else. The failure mode flips from "a new field silently leaks" to
// "a new field silently disappears from exports until someone adds it here",
// which is the right way round for the one module whose output leaves the
// browser. Objects are built with their fields spelled out; because the
// interfaces are the return types, deleting a required field from one of these
// literals IS a compile error, so the list cannot rot in the dangerous
// direction.

/** Project rule 2: custom tables are excluded everywhere data is shared. */
function isCustomTable(name: string): boolean {
  return /_CL$/i.test(name);
}

function maskRecordValues(row: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [column, cell] of Object.entries(row ?? {})) out[column] = redactUnknown(cell);
  return out;
}

function maskSteps(steps: readonly PivotStep[] | undefined): readonly PivotStep[] {
  return (steps ?? []).map((step) => ({
    at: step.at,
    ruleId: step.ruleId,
    indicator: step.indicator,
    value: redactIndicatorValue(step.value, step.indicator),
  }));
}

function maskSnapshot(snapshot: PivotSnapshot): PivotSnapshot {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    platform: snapshot.platform,
    originRuleId: snapshot.originRuleId,
    column: snapshot.column,
    t0: snapshot.t0,
    t0Raw: snapshot.t0Raw,
    source: snapshot.source,
    ...(snapshot.entityName !== undefined ? { entityName: snapshot.entityName } : {}),
    ...(snapshot.runId !== undefined ? { runId: snapshot.runId } : {}),
    value: redactUnknown(snapshot.value),
    host: redactValue(snapshot.host, 'device'),
    row: maskRecordValues(snapshot.row),
    sourceQuery: redactUnknown(snapshot.sourceQuery),
    steps: maskSteps(snapshot.steps),
    // Graph fields (5e-1): ids are opaque and kept; note/pinned rows are customer data.
    ...(snapshot.caseId !== undefined ? { caseId: snapshot.caseId } : {}),
    ...(snapshot.parentSnapshotId !== undefined ? { parentSnapshotId: snapshot.parentSnapshotId } : {}),
    ...(snapshot.parentRunId !== undefined ? { parentRunId: snapshot.parentRunId } : {}),
    ...(snapshot.runIds !== undefined ? { runIds: [...snapshot.runIds] } : {}),
    ...(snapshot.note !== undefined ? { note: redactUnknown(snapshot.note) } : {}),
    ...(snapshot.pinnedRows !== undefined ? { pinnedRows: snapshot.pinnedRows.map(maskRecordValues) } : {}),
  };
}

function maskSummary(summary: RunSummary | undefined): RunSummary {
  const source = summary ?? {};
  const topValues: Record<string, readonly (readonly [string, number])[]> = {};
  for (const [column, pairs] of Object.entries(source.topValues ?? {})) {
    topValues[column] = (pairs ?? []).map(([value, count]) => [redactUnknown(value), count] as const);
  }
  const bySource: Record<string, number> = {};
  for (const [table, count] of Object.entries(source.bySource ?? {})) {
    if (!isCustomTable(table)) bySource[table] = count;
  }
  // `firstSeen`/`lastSeen` are timestamps of the window, not values: kept.
  return {
    ...(source.firstSeen !== undefined ? { firstSeen: source.firstSeen } : {}),
    ...(source.lastSeen !== undefined ? { lastSeen: source.lastSeen } : {}),
    bySource,
    topValues,
  };
}

function maskRun(run: QueryRun): QueryRun {
  return {
    id: run.id,
    caseId: run.caseId,
    tenantKey: run.tenantKey,
    platform: run.platform,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    status: run.status,
    rowCount: run.rowCount,
    lastAccessAt: run.lastAccessAt,
    ...(run.ruleId !== undefined ? { ruleId: run.ruleId } : {}),
    ...(run.snapshotId !== undefined ? { snapshotId: run.snapshotId } : {}),
    // Column NAMES are schema, not customer data (they come from the published
    // table schemas), so they are kept - they are what makes a sample readable.
    columns: (run.columns ?? []).map((column) => ({
      name: column.name,
      type: column.type,
      ...(column.entity !== undefined ? { entity: column.entity } : {}),
    })),
    // DROPPED, and not by `redact.ts`'s hash exemption - that exemption is
    // about FILE hashes (MD5/SHA1/SHA256 of a sample), which are not
    // personal data. `kqlHash` is a SHA-256 of the query TEXT, and that text
    // embeds the pivoted value inside a rule template published in a public
    // repository: given the template, recovering an IPv4 from the hash is a
    // 2^32 enumeration. So a masked export must not carry it. Nothing is
    // lost - the hash only ever served to match a local `pendingRun`
    // (`capture/store.ts`), which is meaningless in another browser, and
    // `ruleId`/`snapshotId` already carry the graph linkage.
    kqlHash: '',
    kqlPreview: redactUnknown(run.kqlPreview),
    ...(run.error !== undefined ? { error: redactUnknown(run.error) } : {}),
    sourceTables: (run.sourceTables ?? []).filter((table) => !isCustomTable(table)),
    summary: maskSummary(run.summary),
    ...(run.rowsSample
      ? { rowsSample: run.rowsSample.map((row) => (row ?? []).map((cell) => redactUnknown(cell))) }
      : {}),
  };
}

function maskPlaybook(playbook: ExportedCase['playbook']): ExportedCase['playbook'] {
  if (!playbook) return undefined;
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(playbook.values ?? {})) values[name] = redactUnknown(value);
  return { id: playbook.id, step: playbook.step, done: [...(playbook.done ?? [])], values };
}

// ── Build (export) ──

export interface BuildCaseExportOptions {
  /**
   * Opt-IN to clear values. Absent/false = masked, which is N2's "valeurs
   * masquées par défaut": there is no setting behind this and no way for a
   * previous export to make the next one leak - see the decision note in
   * `ui/panel/settings-view.ts`.
   */
  readonly includeValues?: boolean;
}

/**
 * Builds the export for one case. `null` if the case does not exist or
 * anything goes wrong (logged, never thrown): a half-built export is worse
 * than none, because its gaps would look like "this case has no runs".
 */
export function buildCaseExport(caseId: string, options?: BuildCaseExportOptions): CaseExport | null {
  try {
    const source = getCase(caseId);
    if (!source) {
      log.warn('case-export: build refused, no such case', { caseId });
      return null;
    }
    const includeValues = options?.includeValues === true;
    const snapshots = getCaseSnapshots(caseId);
    const runs = getCaseRuns(caseId);

    const exportedCase: ExportedCase = {
      id: source.id,
      name: source.name,
      tenantKeys: source.tenantKeys,
      createdAt: source.createdAt,
      lastAccessAt: source.lastAccessAt,
      ...(source.closedAt !== undefined ? { closedAt: source.closedAt } : {}),
      ...(source.archivedAt !== undefined ? { archivedAt: source.archivedAt } : {}),
      tags: source.tags,
      notes: includeValues ? source.notes : redactUnknown(source.notes),
      hadClient: source.clientId !== undefined,
      ...(source.playbook ? { playbook: includeValues ? source.playbook : maskPlaybook(source.playbook) } : {}),
    };

    log.info('case-export: built', {
      caseId,
      snapshots: snapshots.length,
      runs: runs.length,
      redacted: !includeValues,
    });

    return {
      format: CASE_EXPORT_FORMAT,
      version: CASE_EXPORT_VERSION,
      exportedAt: Date.now(),
      redacted: !includeValues,
      case: exportedCase,
      snapshots: includeValues ? snapshots : snapshots.map(maskSnapshot),
      runs: includeValues ? runs : runs.map(maskRun),
    };
  } catch (err) {
    log.error('case-export: build failed', err);
    return null;
  }
}

// ── Parse (import, step 1: format, version, and a hostile-input scrub) ──

export type CaseImportRefusalCode =
  | 'empty'
  | 'too-large'
  | 'not-json'
  | 'not-an-object'
  | 'wrong-format'
  | 'unsupported-version'
  | 'bad-case'
  | 'no-valid-keys';

export interface CaseImportRefusal {
  readonly code: CaseImportRefusalCode;
  /** Short, data-free detail for the log/UI (a version number, a format string). */
  readonly detail?: string;
}

export interface ParsedCaseExport {
  readonly ok: true;
  readonly data: CaseExport;
  /** Entries dropped by the scrub below, reported so nothing is silently lost. */
  readonly dropped: { readonly keys: number; readonly snapshots: number; readonly runs: number };
}

export type CaseImportParseResult = ParsedCaseExport | { readonly ok: false; readonly refusal: CaseImportRefusal };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function strRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(v)) return out;
  for (const [key, value] of Object.entries(v)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * N2: "les clés exportées sont les empreintes, jamais les identifiants".
 * Enforced on the way IN as well, so a hand-edited file cannot smuggle a
 * plaintext `tid` or resourceId into `shq_cases` through the import path.
 * Non-conforming keys are dropped and counted (never silently).
 */
const FINGERPRINT_KEY_RE = /^(?:sentinel|defender):[0-9a-f]{16}$/;

function isFingerprintKey(v: unknown): v is TenantKey {
  return typeof v === 'string' && (v === UNKNOWN_KEY || FINGERPRINT_KEY_RE.test(v));
}

function sanitizeColumns(v: unknown): ParsedColumn[] {
  if (!Array.isArray(v)) return [];
  const out: ParsedColumn[] = [];
  for (const entry of v) {
    if (!isRecord(entry)) continue;
    const name = str(entry.name);
    if (!name) continue;
    const entity = typeof entry.entity === 'string' ? { entity: entry.entity } : {};
    out.push({ name, type: str(entry.type), ...entity });
  }
  return out;
}

function sanitizeSummary(v: unknown): RunSummary {
  if (!isRecord(v)) return {};
  const bySource: Record<string, number> = {};
  if (isRecord(v.bySource)) {
    for (const [key, value] of Object.entries(v.bySource)) {
      if (typeof value === 'number' && Number.isFinite(value)) bySource[key] = value;
    }
  }
  const topValues: Record<string, readonly (readonly [string, number])[]> = {};
  if (isRecord(v.topValues)) {
    for (const [column, pairs] of Object.entries(v.topValues)) {
      if (!Array.isArray(pairs)) continue;
      const kept: (readonly [string, number])[] = [];
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        if (typeof pair[0] !== 'string' || typeof pair[1] !== 'number' || !Number.isFinite(pair[1])) continue;
        kept.push([pair[0], pair[1]] as const);
      }
      topValues[column] = kept;
    }
  }
  return {
    ...(typeof v.firstSeen === 'string' ? { firstSeen: v.firstSeen } : {}),
    ...(typeof v.lastSeen === 'string' ? { lastSeen: v.lastSeen } : {}),
    bySource,
    topValues,
  };
}

/**
 * Row sample, re-capped with the SAME retention knobs a captured run goes
 * through (`capture.maxRowsSample`, `CAPTURE_STORE.MAX_SAMPLE_CELL_CHARS`),
 * so an imported file cannot bypass N1's caps by simply being large.
 * Non-string cells are coerced: a `rowsSample` is display data, and keeping
 * an arbitrary nested object there would hand 5e's renderers something the
 * capture path can never produce.
 */
function sanitizeRowsSample(v: unknown): readonly (readonly unknown[])[] | undefined {
  if (!Array.isArray(v)) return undefined;
  let maxRows = 200;
  try {
    maxRows = getSetting('capture').maxRowsSample;
  } catch {
    // Settings unreadable: fall back to the documented default rather than failing the import.
  }
  const rows: unknown[][] = [];
  for (const row of v.slice(0, Math.max(0, maxRows))) {
    if (!Array.isArray(row)) continue;
    rows.push(
      row.map((cell) => {
        if (cell === null || cell === undefined) return cell;
        if (typeof cell === 'number' || typeof cell === 'boolean') return cell;
        const text = typeof cell === 'string' ? cell : safeString(cell);
        return text.length > CAPTURE_STORE.MAX_SAMPLE_CELL_CHARS
          ? text.slice(0, CAPTURE_STORE.MAX_SAMPLE_CELL_CHARS)
          : text;
      }),
    );
  }
  return rows;
}

function safeString(v: unknown): string {
  try {
    return typeof v === 'object' ? JSON.stringify(v) ?? '' : String(v);
  } catch {
    return '';
  }
}

function sanitizeSteps(v: unknown): PivotStep[] {
  if (!Array.isArray(v)) return [];
  const out: PivotStep[] = [];
  for (const entry of v) {
    if (!isRecord(entry)) continue;
    const indicator = str(entry.indicator);
    // `PIVOT.INDICATOR_PRIORITY` already lists every IndicatorId; no second
    // list to drift from. Widened to `readonly string[]` because the `as
    // const` tuple's `includes()` only accepts its own literal members.
    if (!(PIVOT.INDICATOR_PRIORITY as readonly string[]).includes(indicator)) continue;
    out.push({
      at: num(entry.at),
      ruleId: str(entry.ruleId),
      value: str(entry.value),
      indicator: indicator as IndicatorId,
    });
  }
  return out;
}

function sanitizeSnapshot(v: unknown): PivotSnapshot | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  const source = v.source === 'capture' || v.source === 'grid' ? v.source : 'dom';
  return {
    id,
    createdAt: num(v.createdAt, Date.now()),
    platform: v.platform === 'defender' ? 'defender' : 'sentinel',
    sourceQuery: str(v.sourceQuery),
    originRuleId: str(v.originRuleId),
    steps: sanitizeSteps(v.steps),
    value: str(v.value),
    column: str(v.column),
    t0: str(v.t0),
    t0Raw: str(v.t0Raw),
    host: str(v.host),
    row: strRecord(v.row),
    ...(typeof v.entityName === 'string' ? { entityName: v.entityName } : {}),
    source,
    ...(typeof v.runId === 'string' ? { runId: v.runId } : {}),
    ...(typeof v.caseId === 'string' ? { caseId: v.caseId } : {}),
    ...(typeof v.parentSnapshotId === 'string' && v.parentSnapshotId ? { parentSnapshotId: v.parentSnapshotId } : {}),
    ...(typeof v.parentRunId === 'string' && v.parentRunId ? { parentRunId: v.parentRunId } : {}),
    ...(Array.isArray(v.runIds) ? { runIds: strArray(v.runIds) } : {}),
    ...(typeof v.note === 'string' ? { note: v.note.slice(0, CASES.MAX_NOTE_CHARS) } : {}),
    ...(Array.isArray(v.pinnedRows) ? { pinnedRows: sanitizePinnedRows(v.pinnedRows) } : {}),
  };
}

/** Pinned rows re-capped like captured data: row count and cell length (same cell cap as a snapshot row). */
function sanitizePinnedRows(v: readonly unknown[]): Readonly<Record<string, string>>[] {
  const out: Record<string, string>[] = [];
  for (const entry of v.slice(0, CASES.MAX_PINNED_ROWS)) {
    if (!isRecord(entry)) continue;
    const row: Record<string, string> = {};
    for (const [column, cell] of Object.entries(strRecord(entry))) row[column] = cell.slice(0, SNAPSHOTS.MAX_CELL_CHARS);
    out.push(row);
  }
  return out;
}

/**
 * Makes the graph links of an imported file self-consistent. Snapshot and run
 * ids are KEPT on import (only `caseId` is rewritten, in `applyImport`), so a
 * link is valid exactly when its target is among the file's own snapshots/
 * runs. Anything else - a parent that was capped out of the export, a run
 * beyond `MAX_IMPORT_RUNS`, a self-parent, a hand-edited id - is dropped here
 * rather than left pointing at nothing. `parentSnapshotId` and
 * `parentRunId` are validated independently (the graph treats a missing
 * parent as a root and keeps the node).
 */
function linkSnapshots(snapshots: readonly PivotSnapshot[], runs: readonly QueryRun[]): PivotSnapshot[] {
  const snapshotIds = new Set(snapshots.map((s) => s.id));
  const runIds = new Set(runs.map((r) => r.id));
  return snapshots.map((s) => {
    const { parentSnapshotId, parentRunId, runIds: linked, ...rest } = s;
    const keptRuns = (linked ?? []).filter((id) => runIds.has(id));
    return {
      ...rest,
      ...(parentSnapshotId !== undefined && parentSnapshotId !== s.id && snapshotIds.has(parentSnapshotId)
        ? { parentSnapshotId }
        : {}),
      ...(parentRunId !== undefined && runIds.has(parentRunId) ? { parentRunId } : {}),
      ...(linked !== undefined ? { runIds: [...new Set(keptRuns)] } : {}),
    };
  });
}

function sanitizeRun(v: unknown): QueryRun | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  const rowsSample = sanitizeRowsSample(v.rowsSample);
  return {
    id,
    // Rewritten to the destination case by `applyImport()`; kept only so the
    // object is a complete QueryRun at every step.
    caseId: str(v.caseId),
    tenantKey: isFingerprintKey(v.tenantKey) ? v.tenantKey : UNKNOWN_KEY,
    platform: v.platform === 'defender' ? 'defender' : 'sentinel',
    kqlHash: str(v.kqlHash),
    kqlPreview: str(v.kqlPreview),
    ...(typeof v.ruleId === 'string' ? { ruleId: v.ruleId } : {}),
    ...(typeof v.snapshotId === 'string' ? { snapshotId: v.snapshotId } : {}),
    startedAt: num(v.startedAt),
    durationMs: num(v.durationMs),
    status: v.status === 'error' || v.status === 'truncated' ? v.status : 'ok',
    ...(typeof v.error === 'string' ? { error: v.error } : {}),
    rowCount: num(v.rowCount),
    columns: sanitizeColumns(v.columns),
    sourceTables: strArray(v.sourceTables),
    summary: sanitizeSummary(v.summary),
    ...(rowsSample ? { rowsSample } : {}),
    lastAccessAt: num(v.lastAccessAt, Date.now()),
  };
}

function sanitizeExportedCase(v: unknown): { readonly case: ExportedCase; readonly droppedKeys: number } | null {
  if (!isRecord(v)) return null;
  const rawKeys = Array.isArray(v.tenantKeys) ? v.tenantKeys : [];
  const tenantKeys = [...new Set(rawKeys.filter(isFingerprintKey))];
  const name = str(v.name).trim();
  if (!name) return null;

  let playbook: ExportedCase['playbook'];
  if (isRecord(v.playbook)) {
    playbook = {
      id: str(v.playbook.id),
      step: num(v.playbook.step),
      done: strArray(v.playbook.done),
      values: strRecord(v.playbook.values),
    };
  }

  return {
    case: {
      id: str(v.id),
      name,
      tenantKeys,
      createdAt: num(v.createdAt, Date.now()),
      lastAccessAt: num(v.lastAccessAt, Date.now()),
      ...(optNum(v.closedAt) !== undefined ? { closedAt: optNum(v.closedAt) } : {}),
      ...(optNum(v.archivedAt) !== undefined ? { archivedAt: optNum(v.archivedAt) } : {}),
      tags: strArray(v.tags),
      notes: str(v.notes),
      hadClient: v.hadClient === true,
      ...(playbook ? { playbook } : {}),
    },
    droppedKeys: rawKeys.length - tenantKeys.length,
  };
}

/**
 * Reads a user-chosen file's text into a `CaseExport`, or refuses. Checks
 * size BEFORE `JSON.parse` (a 50 MB file must not be parsed to find out it
 * is too big), then `format`, then `version`, then scrubs every entry
 * field-by-field. Never throws.
 */
export function parseCaseExport(text: unknown): CaseImportParseResult {
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
    if (raw.format !== CASE_EXPORT_FORMAT) {
      return { ok: false, refusal: { code: 'wrong-format', detail: typeof raw.format === 'string' ? raw.format : '' } };
    }
    if (raw.version !== CASE_EXPORT_VERSION) {
      return { ok: false, refusal: { code: 'unsupported-version', detail: safeString(raw.version) } };
    }

    const scrubbed = sanitizeExportedCase(raw.case);
    if (!scrubbed) return { ok: false, refusal: { code: 'bad-case' } };
    if (scrubbed.case.tenantKeys.length === 0) return { ok: false, refusal: { code: 'no-valid-keys' } };

    const rawSnapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
    const rawRuns = Array.isArray(raw.runs) ? raw.runs : [];
    const sanitizedRuns = rawRuns
      .slice(0, CASES.MAX_IMPORT_RUNS)
      .map(sanitizeRun)
      .filter((r): r is QueryRun => r !== null);
    const snapshots = linkSnapshots(
      rawSnapshots
        .slice(0, CASES.MAX_SNAPSHOTS_PER_CASE)
        .map(sanitizeSnapshot)
        .filter((s): s is PivotSnapshot => s !== null),
      sanitizedRuns,
    );
    // The run -> snapshot link must not dangle either (see `linkSnapshots`).
    const keptSnapshotIds = new Set(snapshots.map((s) => s.id));
    const runs = sanitizedRuns.map((r) => {
      if (r.snapshotId === undefined || keptSnapshotIds.has(r.snapshotId)) return r;
      const { snapshotId: _dropped, ...rest } = r;
      return rest;
    });

    const data: CaseExport = {
      format: CASE_EXPORT_FORMAT,
      version: CASE_EXPORT_VERSION,
      exportedAt: num(raw.exportedAt, Date.now()),
      // Absent/garbage `redacted` is treated as MASKED: the pessimistic
      // reading is the safe one here. Calling a clear export "masked" only
      // over-warns; calling a masked export "clear" would present `***`
      // values as real data, which is exactly design point 4's failure.
      redacted: raw.redacted !== false,
      case: scrubbed.case,
      snapshots,
      runs,
    };

    const dropped = {
      keys: scrubbed.droppedKeys,
      snapshots: rawSnapshots.length - snapshots.length,
      runs: rawRuns.length - runs.length,
    };
    log.info('case-export: parsed an import candidate', { redacted: data.redacted, ...dropped });
    return { ok: true, data, dropped };
  } catch (err) {
    // Belt and braces: a refusal is always a value, never an exception.
    log.error('case-export: parse failed unexpectedly', err);
    return { ok: false, refusal: { code: 'not-json' } };
  }
}

// ── Scope check (import, step 2: N2's "refus … sauf confirmation explicite") ──

export interface CaseImportScope extends CaseScope {
  /**
   * Hashed tenant key -> opaque client id, i.e. `ClientKeyIndex.byKey` from
   * `core/clients.ts` (built by the caller, which is also what keeps this
   * module free of any import of the registry - see the file header).
   */
  readonly clientKeys?: ReadonlyMap<TenantKey, string>;
}

function resolveClientId(keys: readonly TenantKey[], scope: CaseImportScope): string | undefined {
  if (!scope.clientKeys) return undefined;
  for (const key of keys) {
    const clientId = scope.clientKeys.get(key);
    if (clientId) return clientId;
  }
  return undefined;
}

/**
 * N2: a case is in scope when one of its keys IS the current key, or when
 * its keys resolve to the client currently being looked at. Exactly the
 * same two conditions as `core/cases.ts`'s `isCaseInScope()`, applied to a
 * file instead of a stored entry.
 */
export function isCaseExportInScope(data: CaseExport, scope: CaseImportScope): boolean {
  const keys = data.case.tenantKeys;
  if (keys.includes(scope.key)) return true;
  const clientId = resolveClientId(keys, scope);
  return clientId !== undefined && scope.clientId !== undefined && clientId === scope.clientId;
}

// ── Apply (import, step 3) ──

export type CaseImportFailureReason = 'out-of-scope' | 'create-failed' | 'error';

export type CaseImportResult =
  | {
      readonly ok: true;
      readonly caseId: string;
      readonly name: string;
      readonly snapshots: number;
      readonly runs: number;
      /** The source file was masked; the new case is marked accordingly. */
      readonly redacted: boolean;
      /** Re-derived from the hashed keys, not from the file (which carries no client id). */
      readonly attachedClientId?: string;
      /** The current key was added to the case because the user accepted a foreign-key import. */
      readonly addedCurrentKey: boolean;
    }
  | { readonly ok: false; readonly reason: CaseImportFailureReason };

/**
 * Always creates a NEW case (new id) rather than overwriting `case.id`:
 * an import must never silently replace work already in this browser, and
 * two colleagues can exchange the same case twice without one erasing the
 * other's annotations.
 */
function applyImport(data: CaseExport, scope: CaseImportScope, foreignConfirmed: boolean): CaseImportResult {
  try {
    const inScope = isCaseExportInScope(data, scope);
    if (!inScope && !foreignConfirmed) {
      log.warn('case-export: import refused, the case keys match neither the current key nor the current client');
      return { ok: false, reason: 'out-of-scope' };
    }

    // A confirmed foreign import gains the CURRENT key, otherwise the case
    // would land in storage invisible to every view (`isCaseInScope()` would
    // reject it) - the same "migration succeeded but the user sees nothing"
    // trap `core/migration.ts` documents. Adding the key IS what the user
    // just confirmed: "yes, bring this other tenant's case in here".
    const addedCurrentKey = !inScope;
    const tenantKeys = addedCurrentKey ? [...new Set([...data.case.tenantKeys, scope.key])] : data.case.tenantKeys;

    const name = data.redacted ? `${data.case.name} ${REDACTED_IMPORT_NAME_SUFFIX}` : data.case.name;
    const attachedClientId = resolveClientId(tenantKeys, scope);
    const created = createCase({ name, clientId: attachedClientId, tenantKeys });
    if (!created.ok) {
      log.error('case-export: import could not create the destination case', { reason: created.reason });
      return { ok: false, reason: 'create-failed' };
    }
    const caseId = created.case.id;

    // Both lists are newest-first and both append functions PREPEND, so
    // oldest-first here reproduces the original order - same reasoning as
    // `core/migration.ts`'s copy steps.
    let snapshots = 0;
    for (const snapshot of [...data.snapshots].reverse()) {
      if (appendSnapshotToCase(caseId, { ...snapshot, caseId }).ok) snapshots++;
    }
    let runs = 0;
    for (const run of [...data.runs].reverse()) {
      if (appendRunToCase(caseId, { ...run, caseId }).ok) runs++;
    }

    const notes = data.redacted
      ? data.case.notes
        ? `${REDACTED_IMPORT_NOTE}\n\n${data.case.notes}`
        : REDACTED_IMPORT_NOTE
      : data.case.notes;
    if (notes) setCaseNotes(caseId, notes);

    const tags = data.redacted ? [...new Set([...data.case.tags, REDACTED_IMPORT_TAG])] : data.case.tags;
    if (tags.length > 0) setCaseTags(caseId, tags);

    // LAST: a closed case refuses every write above. `closedAt` gets a fresh
    // timestamp (there is no API to set it, and writing the index from here
    // would bypass cases.ts's re-read-before-write discipline) - the
    // read-only STATE is what matters and it is preserved. `archivedAt` is
    // deliberately NOT replayed: a freshly imported case the user cannot see
    // is useless, and archiving is local housekeeping, not case content.
    if (data.case.closedAt !== undefined) closeCase(caseId);

    log.info('case-export: imported', {
      caseId,
      snapshots,
      runs,
      redacted: data.redacted,
      addedCurrentKey,
      attached: attachedClientId !== undefined,
    });
    return {
      ok: true,
      caseId,
      name,
      snapshots,
      runs,
      redacted: data.redacted,
      ...(attachedClientId !== undefined ? { attachedClientId } : {}),
      addedCurrentKey,
    };
  } catch (err) {
    log.error('case-export: import failed', err);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Imports a parsed case. Refuses (as a VALUE) when its keys match neither
 * the current tenant key nor the current client - N2's "refus d'un cas dont
 * les clés ne correspondent ni à la clé courante ni au client courant".
 */
export function importCase(data: CaseExport, scope: CaseImportScope): CaseImportResult {
  return applyImport(data, scope, false);
}

/**
 * The "sauf confirmation explicite" path, and deliberately a SEPARATE
 * function rather than an option on `importCase()`: a permissive boolean
 * eventually gets passed `true` by a caller that never asked the user, and
 * a defaulted one gets flipped by a refactor. Call this only after the user
 * has actually agreed to import a case belonging to another tenant.
 */
export function importCaseAcceptingForeignKeys(data: CaseExport, scope: CaseImportScope): CaseImportResult {
  log.info('case-export: importing a foreign-key case after explicit confirmation');
  return applyImport(data, scope, true);
}
