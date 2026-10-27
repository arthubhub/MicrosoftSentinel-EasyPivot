import type { IndicatorId, PivotSnapshot, QueryRun } from '../types.ts';
import { CAPTURE_STORE } from '../config.ts';
import { getCase, getCaseRuns, getCaseSnapshots } from './cases.ts';
import { detectForCell } from './detection.ts';
import { buildTree, timeline, type TreeNode } from './graph.ts';
import { log } from './log.ts';
import {
  createTextRedactor,
  kindForTyped,
  redactKqlStringLiterals,
  redactTypedValue,
  redactUnknown,
  type KnownValue,
} from './redact.ts';
import { getLang, t } from '../i18n/index.ts';

/**
 * Case report (N3, phase 5f). Pure logic, no DOM, no clipboard, no download:
 * `ui/report-dialog.ts` owns those and is the only route a report leaves by.
 *
 * ── Why this module does not import `core/clients.ts` ──
 * Same rule as `core/case-export.ts`: the registry is the one place holding a
 * tenant id / workspace resourceId / workspace name in clear, and a report must
 * never be able to see them. There is no import of it here, so "no tid in the
 * report" is structural. The client NAME is identifying too: it is printed only
 * through `ReportOptions.clientName`, which the UI passes explicitly, and is
 * masked when masking is on. The case id is never printed either (name + dates).
 *
 * ── Shape of the code ──
 * `buildReportModel()` does ALL the data work (what is masked, how, which text
 * is dropped) and yields plain strings; the two renderers only lay those out
 * and ESCAPE. Masking therefore happens once, and cannot differ between the
 * Markdown and the HTML.
 *
 * ── Masking (default; `ReportOptions.redact`) ──
 * Every value goes through `core/redact.ts`:
 *  - timeline / indicators / tree: `redactTypedValue` (shape first, then the
 *    step's indicator; snapshot values are typed with `detectForCell`, and fall
 *    back to the opaque `***` when detection finds nothing - never to clear);
 *  - pinned-row cells: `redactUnknown` per cell (timestamps and numbers of up to
 *    six digits are kept: they identify nobody);
 *  - notes and the case name: a TOKEN-level masker (known values of the case +
 *    recognisable shapes). Weaker than a whole-field `***`, which is why the
 *    masked report carries a notice saying so. See `createTextRedactor`;
 *  - KQL appendix: every string literal masked and every comment blanked
 *    (`// ***`, rule-id tag kept), then the text masker over what is left.
 * What is shown with masking OFF is the stored value, minus the two things that
 * are never printed in any mode: custom `_CL` table names (project rule 2) and
 * the full-length KQL (only the stored 300-character preview exists).
 *
 * ── Hostile data ──
 * Values, notes, column names, case and client names come from the portal or
 * from imported files. Nothing is concatenated into markup raw: `escapeHtml` /
 * `mdEscape` / `mdValue` below are the only ways text reaches either output.
 * The HTML has no script, no external resource and a CSP meta tag as a second
 * line of defence.
 */

// ── Public API ──

export interface ReportOptions {
  /** Mask values. The caller decides; this module has no default of its own. */
  readonly redact: boolean;
  /**
   * Client name, passed by the UI (which already shows it). Printed in the case
   * header only; masked when `redact` is on; also fed to the text masker so a
   * case name or a note that mentions it is masked too.
   */
  readonly clientName?: string;
  /**
   * Name to print as the case title, passed by the UI (`ui/case-name.ts`): a
   * system case ("Non attribué") is stored in French and must read in the
   * current language. Omitted -> the stored name. Masked like any case name.
   */
  readonly caseName?: string;
  /** Generation time (ms), injectable for reproducible output */
  readonly generatedAt?: number;
}

export interface Report {
  readonly markdown: string;
  readonly html: string;
  readonly masked: boolean;
  /** Counts only, for logging and the UI toast */
  readonly stats: { readonly timeline: number; readonly indicators: number; readonly evidenceRows: number; readonly nodes: number; readonly queries: number };
}

// ── Model ──

interface InfoRow {
  readonly label: string;
  /** '' = left blank on purpose (author) */
  readonly value: string;
}

interface TimelineRow {
  readonly cells: readonly [date: string, rule: string, value: string, rows: string, status: string];
}

interface IndicatorGroup {
  readonly title: string;
  readonly entries: readonly { readonly value: string; readonly pivots: string }[];
}

interface EvidenceBlock {
  readonly node: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

interface TreeLine {
  readonly depth: number;
  readonly label: string;
  readonly meta: string;
  readonly note: string;
}

interface QueryBlock {
  readonly heading: string;
  readonly kql: string;
}

interface ReportModel {
  readonly lang: string;
  readonly masked: boolean;
  readonly title: string;
  readonly heading: string;
  readonly notice: string;
  /** Label of the client row (its value is customer-supplied text, unlike dates and status) */
  readonly clientLabel: string;
  readonly labels: {
    readonly s1: string;
    readonly s2: string;
    readonly s3: string;
    readonly s4: string;
    readonly s5: string;
    readonly s6: string;
    readonly s7: string;
    readonly timelineHead: readonly string[];
    readonly timelineLegend: string;
  };
  readonly info: readonly InfoRow[];
  readonly summary: string;
  readonly emptySummary: string;
  readonly timeline: readonly TimelineRow[];
  readonly emptyTimeline: string;
  readonly indicators: readonly IndicatorGroup[];
  readonly emptyIndicators: string;
  readonly evidence: readonly EvidenceBlock[];
  readonly emptyEvidence: string;
  readonly tree: readonly TreeLine[];
  readonly emptyTree: string;
  readonly appendixNotes: readonly string[];
  readonly queries: readonly QueryBlock[];
  readonly emptyAppendix: string;
}

// ── Text hygiene ──

/** Custom-table names (`…_CL`) never appear in a report (project rule 2), masked or not. */
const CUSTOM_TABLE_RE = /[A-Za-z0-9_]*_CL(?![A-Za-z0-9])/gi;

/** Control characters other than \n and \t have no place in either output. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(text: string): string {
  return text.replace(CONTROL_RE, '').replace(CUSTOM_TABLE_RE, '***');
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  try {
    return String(v);
  } catch {
    return '';
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function fmtDate(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function short(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Same exemption as `createTextRedactor`: a timestamp or a short number identifies nobody. */
function isInertCell(v: string): boolean {
  return /^\d{1,6}$/.test(v) || /^\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?$/.test(v);
}

// ── Building the model ──

const TYPE_ORDER: readonly (IndicatorId | 'other')[] = [
  'ip', 'account', 'email', 'url', 'domain', 'device', 'process', 'application', 'hash', 'other',
];

function typeTitle(type: IndicatorId | 'other'): string {
  switch (type) {
    case 'ip': return t('report.type.ip');
    case 'account': return t('report.type.account');
    case 'email': return t('report.type.email');
    case 'url': return t('report.type.url');
    case 'domain': return t('report.type.domain');
    case 'device': return t('report.type.device');
    case 'process': return t('report.type.process');
    case 'application': return t('report.type.application');
    case 'hash': return t('report.type.hash');
    default: return t('report.type.other');
  }
}

/** Indicator type of a snapshot's own value, from the existing detection; undefined when unsure. */
function snapshotType(snap: PivotSnapshot): IndicatorId | undefined {
  try {
    return detectForCell(snap.value, snap.column, snap.entityName).candidates[0];
  } catch {
    return undefined;
  }
}

function collectKnown(
  snapshots: readonly PivotSnapshot[],
  runs: readonly QueryRun[],
  stepTypes: ReadonlyMap<string, IndicatorId>,
  clientName: string | undefined,
): KnownValue[] {
  const known: KnownValue[] = [];
  const push = (v: unknown): void => {
    const s = str(v).trim();
    if (s) known.push(s);
  };
  if (clientName) known.push({ value: clientName, kind: 'opaque' });
  for (const snap of snapshots) {
    const type = snapshotType(snap);
    if (snap.value) known.push({ value: snap.value, kind: kindForTyped(snap.value, type) });
    if (snap.host) known.push({ value: snap.host, kind: 'device' });
    for (const v of Object.values(snap.row ?? {})) push(v);
    for (const row of snap.pinnedRows ?? []) for (const v of Object.values(row)) push(v);
    for (const step of snap.steps ?? []) {
      if (step.value) known.push({ value: step.value, kind: kindForTyped(step.value, step.indicator) });
    }
  }
  for (const [value, type] of stepTypes) known.push({ value, kind: kindForTyped(value, type) });
  for (const run of runs) {
    for (const entries of Object.values(run.summary?.topValues ?? {})) for (const [v] of entries) push(v);
    for (const row of run.rowsSample ?? []) for (const v of row) push(v);
  }
  return known;
}

function buildReportModel(caseId: string, options: ReportOptions): ReportModel | null {
  const c = getCase(caseId);
  if (!c) return null;
  const masked = options.redact;
  const snapshots = getCaseSnapshots(caseId);
  const runs = [...getCaseRuns(caseId)].sort((a, b) => a.startedAt - b.startedAt);
  const entries = timeline(caseId);

  const stepTypes = new Map<string, IndicatorId>();
  for (const e of entries) if (e.value) stepTypes.set(e.value, e.indicator);

  const redactText = masked
    ? createTextRedactor(collectKnown(snapshots, runs, stepTypes, options.clientName))
    : (s: string): string => s;

  /** Free text (notes, names): hygiene, then the token masker when masking. */
  const text = (s: string): string => redactText(clean(s));
  /** A value with a known type. */
  const typed = (v: string, type: IndicatorId | undefined): string => {
    const x = clean(v);
    return masked ? redactTypedValue(x, type) : x;
  };
  /** A table cell: customer data of unknown shape. */
  const cellText = (v: unknown): string => {
    const x = clean(str(v));
    if (!masked) return x;
    return isInertCell(x.trim()) ? x : redactUnknown(x);
  };

  const snapById = new Map<string, PivotSnapshot>();
  for (const s of snapshots) if (!snapById.has(s.id)) snapById.set(s.id, s);

  const nodeLabel = (snap: PivotSnapshot): string => {
    const col = snap.column ? `${clean(snap.column)}: ` : '';
    return short(oneLine(`${col}${typed(snap.value, snapshotType(snap))}`), 160);
  };

  // 1. Case
  const clientText = options.clientName ? (masked ? '***' : clean(options.clientName)) : '';
  const info: InfoRow[] = [];
  if (clientText) info.push({ label: t('report.client'), value: clientText });
  info.push({ label: t('report.status'), value: c.closedAt !== undefined ? t('report.statusClosed') : t('report.statusOpen') });
  info.push({ label: t('report.opened'), value: fmtDate(c.createdAt) });
  if (c.closedAt !== undefined) info.push({ label: t('report.closed'), value: fmtDate(c.closedAt) });
  info.push({ label: t('report.generated'), value: fmtDate(options.generatedAt ?? Date.now()) });
  info.push({ label: t('report.author'), value: '' });

  // 3. Timeline
  const timelineRows: TimelineRow[] = entries.map((e) => ({
    cells: [
      fmtDate(e.at),
      masked ? redactText(clean(e.ruleId)) : clean(e.ruleId),
      oneLine(typed(e.value, e.indicator)),
      e.rows === null ? t('report.rowsUnknown') : String(e.rows),
      [e.truncated ? t('report.truncated') : '', e.error ? t('report.error') : ''].filter(Boolean).join(', '),
    ],
  }));

  // 4. Indicators: deduplicated on the REAL value (case-insensitive), steps first so their type wins.
  const dedup = new Map<string, { type: IndicatorId | undefined; value: string; pivots: number }>();
  for (const e of entries) {
    const key = e.value.trim().toLowerCase();
    if (!key) continue;
    const hit = dedup.get(key);
    if (hit) hit.pivots++;
    else dedup.set(key, { type: e.indicator, value: e.value, pivots: 1 });
  }
  for (const snap of snapshots) {
    const key = snap.value.trim().toLowerCase();
    if (!key || dedup.has(key)) continue;
    dedup.set(key, { type: snapshotType(snap), value: snap.value, pivots: 0 });
  }
  const groups = new Map<IndicatorId | 'other', { value: string; pivots: string }[]>();
  for (const item of dedup.values()) {
    const g = item.type ?? 'other';
    const list = groups.get(g) ?? [];
    list.push({ value: oneLine(typed(item.value, item.type)), pivots: item.pivots > 0 ? t('report.pivots', { n: item.pivots }) : '' });
    groups.set(g, list);
  }
  const indicatorGroups: IndicatorGroup[] = TYPE_ORDER.filter((g) => groups.has(g)).map((g) => ({
    title: typeTitle(g),
    entries: groups.get(g) ?? [],
  }));

  // 5. Evidence
  const evidence: EvidenceBlock[] = [];
  let evidenceRows = 0;
  for (const snap of snapshots) {
    const pinned = snap.pinnedRows ?? [];
    if (pinned.length === 0) continue;
    const columns: string[] = [];
    for (const row of pinned) for (const col of Object.keys(row)) if (!columns.includes(col)) columns.push(col);
    evidenceRows += pinned.length;
    evidence.push({
      node: nodeLabel(snap),
      columns: columns.map((col) => oneLine(clean(col))),
      rows: pinned.map((row) => columns.map((col) => oneLine(cellText(row[col])))),
    });
  }

  // 6. Tree + notes (depth-first, iterative, oldest first as buildTree orders them)
  const tree: TreeLine[] = [];
  const stack: { node: TreeNode; depth: number }[] = [];
  const roots = buildTree(caseId).roots;
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], depth: 0 });
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const snap = snapById.get(item.node.snapshotId);
    if (snap) {
      const r = item.node.lastResult;
      const meta = r
        ? [t('report.rows', { n: r.rows }), r.truncated ? t('report.truncated') : '', r.error ? t('report.error') : '']
            .filter(Boolean)
            .join(', ')
        : '';
      tree.push({ depth: item.depth, label: nodeLabel(snap), meta, note: text(snap.note ?? '').trim() });
    }
    for (let i = item.node.children.length - 1; i >= 0; i--) stack.push({ node: item.node.children[i], depth: item.depth + 1 });
  }

  // 7. Appendix
  const appendixNotes = [t('report.appendixTruncated', { max: CAPTURE_STORE.KQL_PREVIEW_CHARS })];
  if (masked) appendixNotes.push(t('report.appendixMasked'));
  const queries: QueryBlock[] = runs.map((run) => {
    const raw = str(run.kqlPreview);
    const kql = raw.trim() === '' ? t('report.noQuery') : masked ? redactText(clean(redactKqlStringLiterals(raw, { comments: 'mask' }))) : clean(raw);
    const status = run.status === 'truncated' ? t('report.truncated') : run.status === 'error' ? t('report.error') : '';
    const heading = [fmtDate(run.startedAt), run.ruleId ? (masked ? redactText(clean(run.ruleId)) : clean(run.ruleId)) : '', status]
      .filter(Boolean)
      .join(' · ');
    return { heading, kql };
  });

  const caseName = oneLine(text(options.caseName ?? c.name));
  return {
    lang: getLang(),
    masked,
    title: caseName,
    heading: t('report.title'),
    notice: masked ? t('report.notice.masked') : t('report.notice.clear'),
    clientLabel: t('report.client'),
    labels: {
      s1: t('report.s1'),
      s2: t('report.s2'),
      s3: t('report.s3'),
      s4: t('report.s4'),
      s5: t('report.s5'),
      s6: t('report.s6'),
      s7: t('report.s7'),
      timelineHead: [t('report.col.date'), t('report.col.rule'), t('report.col.value'), t('report.col.rows'), t('report.col.status')],
      timelineLegend: t('report.timelineLegend'),
    },
    info,
    summary: text(c.notes ?? '').trim(),
    emptySummary: t('report.emptySummary'),
    timeline: timelineRows,
    emptyTimeline: t('report.emptyTimeline'),
    indicators: indicatorGroups,
    emptyIndicators: t('report.emptyIndicators'),
    evidence,
    emptyEvidence: t('report.emptyEvidence'),
    tree,
    emptyTree: t('report.emptyTree'),
    appendixNotes,
    queries,
    emptyAppendix: t('report.emptyAppendix'),
  };
}

// ── Markdown renderer ──
//
// Every piece of data passes through `mdEscape` (plain text) or `mdValue`
// (a value, in inline code when that is safe). Escaped: backslash, backtick,
// `[ ] ( ) < > | * _ ~ &`, a leading block marker, and `://` (so no renderer
// auto-links a URL in a note). Newlines never reach a table cell or a list item.

function mdEscape(s: string, lineStart = false): string {
  let out = s
    // `<`, `>` and `&` as entities, not backslashes: the raw `<img` never appears in the output
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]|~]/g, (ch) => `\\${ch}`)
    .replace(/\\\]\(/g, '\\]\\(') // `](` can never start a link target
    .replace(/:\/\//g, ':\\/\\/');
  if (lineStart) out = out.replace(/^([#+\-=])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2');
  return out;
}

/**
 * A value inside a line or a table cell. Inline code with a fence one longer
 * than the longest backtick run inside, which no value can close early. A value
 * containing `<`, `>`, `[` or `]` is NOT put in a code span (the raw characters
 * would stay in the text, and a plain-text consumer would see a tag or a link):
 * it is escaped instead (`&lt;`, `\[`), which every CommonMark renderer shows
 * faithfully and none parses as a tag or a link.
 */
function mdValue(v: string, inTable: boolean): string {
  const s = oneLine(v);
  if (s === '') return '';
  if (/[<>[\]]/.test(s)) return mdEscape(s);
  let longest = 0;
  for (const run of s.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  const body = inTable ? s.replace(/\|/g, '\\|') : s;
  const pad = body.startsWith('`') || body.endsWith('`') || (body.startsWith(' ') && body.endsWith(' ')) ? ' ' : '';
  return `${fence}${pad}${body}${pad}${fence}`;
}

/** Multi-line plain text as a blockquote: each line escaped and prefixed, so it cannot start a heading or a table. */
function mdQuote(text: string, indent: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() === '' ? `${indent}>` : `${indent}> ${mdEscape(line.trimEnd(), true)}  `))
    .join('\n');
}

function mdRow(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function mdTable(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [mdRow(head.map((h) => mdEscape(oneLine(h)))), mdRow(head.map(() => '---'))];
  for (const r of rows) lines.push(mdRow(r));
  return lines.join('\n');
}

/** A code fence longer than any backtick (or tilde) run inside the text. */
function mdFence(code: string): string {
  let longest = 2;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const f = '`'.repeat(longest + 1);
  return `${f}\n${code}\n${f}`;
}

function renderMarkdown(m: ReportModel): string {
  const out: string[] = [];
  out.push(`# ${mdEscape(oneLine(`${m.heading}: ${m.title}`))}`, '');
  out.push(mdQuote(m.notice, ''), '');

  out.push(`## ${mdEscape(m.labels.s1)}`, '');
  for (const row of m.info) out.push(`- **${mdEscape(row.label)}:**${row.value ? ` ${row.label === m.clientLabel ? mdValue(row.value, false) : mdEscape(row.value)}` : ''}`);
  out.push('');

  out.push(`## ${mdEscape(m.labels.s2)}`, '');
  out.push(m.summary ? mdQuote(m.summary, '') : mdEscape(m.emptySummary), '');

  out.push(`## ${mdEscape(m.labels.s3)}`, '');
  if (m.timeline.length === 0) out.push(mdEscape(m.emptyTimeline), '');
  else {
    out.push(
      mdTable(
        m.labels.timelineHead,
        m.timeline.map((r) => r.cells.map((cell, i) => (i === 1 || i === 2 ? mdValue(cell, true) : mdEscape(cell)))),
      ),
      '',
      `_${mdEscape(m.labels.timelineLegend)}_`,
      '',
    );
  }

  out.push(`## ${mdEscape(m.labels.s4)}`, '');
  if (m.indicators.length === 0) out.push(mdEscape(m.emptyIndicators), '');
  for (const g of m.indicators) {
    out.push(`### ${mdEscape(g.title)}`, '');
    g.entries.forEach((e, i) => out.push(`${i + 1}. ${mdValue(e.value, false)}${e.pivots ? ` (${mdEscape(e.pivots)})` : ''}`));
    out.push('');
  }

  out.push(`## ${mdEscape(m.labels.s5)}`, '');
  if (m.evidence.length === 0) out.push(mdEscape(m.emptyEvidence), '');
  for (const block of m.evidence) {
    out.push(`### ${mdEscape(block.node)}`, '');
    out.push(mdTable(block.columns, block.rows.map((r) => r.map((cell) => mdValue(cell, true)))), '');
  }

  out.push(`## ${mdEscape(m.labels.s6)}`, '');
  if (m.tree.length === 0) out.push(mdEscape(m.emptyTree), '');
  for (const line of m.tree) {
    const indent = '  '.repeat(Math.min(line.depth, 8));
    out.push(`${indent}- ${mdValue(line.label, false)}${line.meta ? ` (${mdEscape(line.meta)})` : ''}`);
    if (line.note) out.push('', mdQuote(line.note, `${indent}  `), '');
  }
  out.push('');

  out.push(`## ${mdEscape(m.labels.s7)}`, '');
  for (const note of m.appendixNotes) out.push(`_${mdEscape(note)}_`, '');
  if (m.queries.length === 0) out.push(mdEscape(m.emptyAppendix), '');
  for (const q of m.queries) out.push(`### ${mdEscape(q.heading)}`, '', mdFence(q.kql), '');

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ── HTML renderer ──

/** Text AND attribute contexts: `&`, `<`, `>`, both quotes and the backtick (legacy attribute quoting). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

const E = escapeHtml;

const HTML_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 64px; background: #f3f2f1; color: #201f1e;
    font: 14px/1.55 "Segoe UI", system-ui, -apple-system, sans-serif; }
  main { max-width: 960px; margin: 0 auto; background: #fff; padding: 32px 40px;
    border: 1px solid #e1dfdd; border-radius: 4px; }
  h1 { font-size: 22px; margin: 0 0 16px; overflow-wrap: anywhere; }
  h2 { font-size: 16px; margin: 32px 0 10px; padding-bottom: 4px; border-bottom: 2px solid #0078d4; }
  h3 { font-size: 13px; margin: 18px 0 6px; color: #323130; overflow-wrap: anywhere; }
  .notice { margin: 0 0 20px; padding: 10px 14px; border-left: 4px solid #8a8886; background: #f3f2f1; font-size: 13px; }
  .notice.masked { border-left-color: #c19c00; background: #fff8e1; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
  dt { font-weight: 600; color: #605e5c; }
  dd { margin: 0; min-height: 1.55em; overflow-wrap: anywhere; }
  dd.blank { border-bottom: 1px dotted #8a8886; min-width: 240px; }
  code { font: 12px/1.4 Consolas, "Courier New", monospace; background: #f3f2f1; padding: 1px 5px; border-radius: 2px;
    overflow-wrap: break-word; }
  td code { white-space: pre-wrap; }
  pre { margin: 0; padding: 10px 12px; background: #f3f2f1; border: 1px solid #e1dfdd; border-radius: 2px; overflow-x: auto; }
  pre code { background: none; padding: 0; white-space: pre; overflow-wrap: normal; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; vertical-align: top; padding: 5px 8px; border: 1px solid #e1dfdd; }
  th { background: #f3f2f1; font-weight: 600; white-space: nowrap; }
  .muted { color: #605e5c; font-size: 12px; }
  .note { margin: 4px 0 8px; padding: 6px 10px; border-left: 3px solid #c8c6c4; background: #faf9f8;
    white-space: pre-wrap; overflow-wrap: anywhere; }
  ul.tree { list-style: none; margin: 0; padding: 0; }
  ul.tree li { margin: 3px 0; padding-left: calc(var(--depth, 0) * 18px); }
  ol { margin: 0 0 8px; padding-left: 22px; }
  @media print { body { background: #fff; padding: 0; } main { border: 0; padding: 0; max-width: none; } }
`;

function htmlTable(head: readonly string[], rows: readonly (readonly string[])[], codeCols: ReadonlySet<number>): string {
  const th = head.map((h) => `<th scope="col">${E(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((cell, i) => `<td>${codeCols.has(i) && cell ? `<code>${E(cell)}</code>` : E(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderHtml(m: ReportModel): string {
  const p: string[] = [];
  p.push(`<h1>${E(`${m.heading}: ${m.title}`)}</h1>`);
  p.push(`<p class="notice${m.masked ? ' masked' : ''}" role="note">${E(m.notice)}</p>`);

  p.push(`<h2>${E(m.labels.s1)}</h2>`);
  p.push(
    `<dl>${m.info.map((r) => `<dt>${E(r.label)}</dt><dd${r.value ? '' : ' class="blank"'}>${E(r.value)}</dd>`).join('')}</dl>`,
  );

  p.push(`<h2>${E(m.labels.s2)}</h2>`);
  p.push(m.summary ? `<div class="note">${E(m.summary)}</div>` : `<p class="muted">${E(m.emptySummary)}</p>`);

  p.push(`<h2>${E(m.labels.s3)}</h2>`);
  if (m.timeline.length === 0) p.push(`<p class="muted">${E(m.emptyTimeline)}</p>`);
  else {
    p.push(htmlTable(m.labels.timelineHead, m.timeline.map((r) => r.cells), new Set([1, 2])));
    p.push(`<p class="muted">${E(m.labels.timelineLegend)}</p>`);
  }

  p.push(`<h2>${E(m.labels.s4)}</h2>`);
  if (m.indicators.length === 0) p.push(`<p class="muted">${E(m.emptyIndicators)}</p>`);
  for (const g of m.indicators) {
    p.push(`<h3>${E(g.title)}</h3>`);
    p.push(
      `<ol>${g.entries
        .map((e) => `<li><code>${E(e.value)}</code>${e.pivots ? ` <span class="muted">(${E(e.pivots)})</span>` : ''}</li>`)
        .join('')}</ol>`,
    );
  }

  p.push(`<h2>${E(m.labels.s5)}</h2>`);
  if (m.evidence.length === 0) p.push(`<p class="muted">${E(m.emptyEvidence)}</p>`);
  for (const b of m.evidence) {
    p.push(`<h3>${E(b.node)}</h3>`);
    p.push(htmlTable(b.columns, b.rows, new Set(b.columns.map((_c, i) => i))));
  }

  p.push(`<h2>${E(m.labels.s6)}</h2>`);
  if (m.tree.length === 0) p.push(`<p class="muted">${E(m.emptyTree)}</p>`);
  else {
    p.push(
      `<ul class="tree">${m.tree
        .map(
          (l) =>
            `<li style="--depth:${Math.min(l.depth, 8)}"><code>${E(l.label)}</code>${l.meta ? ` <span class="muted">(${E(l.meta)})</span>` : ''}${
              l.note ? `<div class="note">${E(l.note)}</div>` : ''
            }</li>`,
        )
        .join('')}</ul>`,
    );
  }

  p.push(`<h2>${E(m.labels.s7)}</h2>`);
  for (const note of m.appendixNotes) p.push(`<p class="muted">${E(note)}</p>`);
  if (m.queries.length === 0) p.push(`<p class="muted">${E(m.emptyAppendix)}</p>`);
  for (const q of m.queries) p.push(`<h3>${E(q.heading)}</h3><pre><code>${E(q.kql)}</code></pre>`);

  return [
    '<!doctype html>',
    `<html lang="${E(m.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    // Second line of defence: even a missed escape cannot run script or load anything.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${E(`${m.heading}: ${m.title}`)}</title>`,
    `<style>${HTML_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    p.join('\n'),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ── Entry point ──

/**
 * Build both renderings of one case's report. `null` when the case does not
 * exist or building failed (never throws). Generated on demand only - nothing
 * here runs unless the UI calls it.
 */
export function buildReport(caseId: string, options: ReportOptions): Report | null {
  try {
    const model = buildReportModel(caseId, options);
    if (!model) return null;
    const markdown = renderMarkdown(model);
    const html = renderHtml(model);
    const stats = {
      timeline: model.timeline.length,
      indicators: model.indicators.reduce((n, g) => n + g.entries.length, 0),
      evidenceRows: model.evidence.reduce((n, b) => n + b.rows.length, 0),
      nodes: model.tree.length,
      queries: model.queries.length,
    };
    log.info('report: built', { masked: model.masked, ...stats, markdownChars: markdown.length, htmlChars: html.length });
    return { markdown, html, masked: model.masked, stats };
  } catch (err) {
    log.error('report: build failed', err);
    return null;
  }
}
