/**
 * `audit:signatures` guard: pnpm below 11.1.0 silently discards the `signatures` subcommand
 * and degrades to an ordinary advisory audit that still exits 0, so this decides on report
 * shape alone, never on a pnpm version. Known boundary: `audited` is a floor pnpm can shrink
 * silently (unpublished packages, registries with no signing keys); only auditing zero packages is rejected.
 */

/** Subcommand and flags the guard runs. `--json` is what makes the contract checkable. */
export const SIGNATURE_AUDIT_ARGS = ['audit', 'signatures', '--json'] as const;

/** First pnpm release that implements the subcommand; quoted in the rejection message. */
export const MINIMUM_SIGNATURE_AUDIT_PNPM_VERSION = '11.1.0';

/** One `pnpm audit signatures --json` run, normalized so the decision stays pure. */
export interface SignatureAuditExecution {
  /** Human-readable command line; used in messages only. */
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  /** Process exit code, or `undefined` when the process never reported one. */
  readonly exitCode: number | undefined;
}

/** The documented pnpm signature report, validated down to its own arithmetic. */
export interface SignatureAuditReport {
  readonly audited: number;
  readonly verified: number;
  /** Packages the registry has signing keys for but published without a signature. */
  readonly missing: readonly unknown[];
  /** Packages whose signature failed verification, or whose metadata could not be read. */
  readonly invalid: readonly unknown[];
}

/** Why a run must not be read as "signatures verified". */
export type SignatureAuditRejectionReason
  = | 'process-failed'
    | 'empty-output'
    | 'malformed-json'
    | 'advisory-report'
    | 'unrecognized-schema'
    | 'count-mismatch'
    | 'invalid-signatures'
    | 'missing-signatures'
    | 'unexpected-exit'
    | 'nothing-audited';

/** Every audited package carried a signature that verified against the registry keys. */
export interface SignatureAuditVerifiedOutcome {
  readonly kind: 'verified';
  readonly report: SignatureAuditReport;
  readonly exitCode: number;
}

/** The run produced no usable proof of verification; it must never read as a pass. */
export interface SignatureAuditRejectedOutcome {
  readonly kind: 'rejected';
  readonly reason: SignatureAuditRejectionReason;
  readonly detail: string;
}

export type SignatureAuditOutcome = SignatureAuditVerifiedOutcome | SignatureAuditRejectedOutcome;

export interface SignatureAuditCliDependencies {
  /** Runs the signature audit and reports its output and exit code without throwing on a failed audit. */
  readonly runAudit: () => Promise<SignatureAuditExecution>;
  readonly writeOut: (line: string) => void;
  readonly writeError: (line: string) => void;
}

/**
 * Spawned from `PATH` on purpose: pnpm 11 self-switches to the repository's `packageManager`
 * pin, and CI installs that same pinned version, so both paths audit the declared version.
 * Windows exposes the launcher as a `.cmd` shim, which `execFile` cannot start without it.
 */
export function resolvePnpmExecutable(platform: string): string {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

/** Rejects any argument: the guard takes none, and a typo must not silently change the run. */
export function parseSignatureAuditArgs(argv: readonly string[]): void {
  if (argv.length > 0) {
    throw new Error(`Unknown argument: ${argv[0]}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === '' ? '' : `; stderr: ${trimmed}`;
}

/**
 * Recognizes the two documented npm/pnpm advisory shapes, the same pair `src/utils/auditClient.ts`
 * accepts — what pnpm below 11.1 returns for `audit signatures`, so it gets a specific diagnosis
 * instead of a generic "unknown schema".
 */
function isAdvisoryReport(json: unknown): boolean {
  if (!isPlainObject(json)) {
    return false;
  }
  const hasSummary = isPlainObject(json.metadata);
  return (isPlainObject(json.advisories) && hasSummary)
    || (isPlainObject(json.vulnerabilities) && (hasSummary || typeof json.auditReportVersion === 'number'));
}

function recognizeSignatureReport(json: unknown): SignatureAuditReport | undefined {
  if (!isPlainObject(json)) {
    return undefined;
  }
  const { audited, invalid, missing, verified } = json;
  if (!isCount(audited) || !isCount(verified) || !Array.isArray(missing) || !Array.isArray(invalid)) {
    return undefined;
  }
  return { audited, invalid, missing, verified };
}

/** Best-effort one-line description of a finding; a malformed entry is still reported, never dropped. */
function describeFinding(entry: unknown): string {
  if (!isPlainObject(entry)) {
    return JSON.stringify(entry);
  }
  const name = typeof entry.name === 'string' ? entry.name : '<unknown>';
  const version = typeof entry.version === 'string' ? entry.version : '<unknown>';
  const reason = typeof entry.reason === 'string' ? ` — ${entry.reason}` : '';
  return `${name}@${version}${reason}`;
}

/** Lists every finding: the run already failed, so a truncated list would only hide work. */
function describeFindings(entries: readonly unknown[]): string {
  return entries.map(describeFinding).join(', ');
}

function reject(reason: SignatureAuditRejectionReason, detail: string): SignatureAuditRejectedOutcome {
  return { kind: 'rejected', reason, detail };
}

/**
 * Classifies one signature audit run. Every branch but the last is a rejection,
 * so an unexpected report shape or an unexpected exit code can never be read as
 * "verified".
 */
export function evaluateSignatureAudit(execution: SignatureAuditExecution): SignatureAuditOutcome {
  const { command, exitCode, stderr, stdout } = execution;

  if (exitCode === undefined) {
    return reject('process-failed', `${command} never reported an exit code${describeStderr(stderr)}`);
  }

  const output = stdout.trim();
  if (output === '') {
    return reject(
      'empty-output',
      `${command} wrote no report to stdout (exit code ${exitCode})${describeStderr(stderr)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(output);
  }
  catch (error) {
    return reject(
      'malformed-json',
      `${command} wrote ${output.length} byte(s) to stdout that are not JSON `
      + `(exit code ${exitCode}): ${describeError(error)}`,
    );
  }

  if (isAdvisoryReport(json)) {
    return reject(
      'advisory-report',
      `${command} returned a vulnerability advisory report instead of a signature report `
      + `(exit code ${exitCode}). pnpm implements the "audit signatures" subcommand from `
      + `${MINIMUM_SIGNATURE_AUDIT_PNPM_VERSION} onwards and silently ignores the positional `
      + 'argument before that, so no signature was verified.',
    );
  }

  const report = recognizeSignatureReport(json);
  if (report === undefined) {
    return reject(
      'unrecognized-schema',
      `${command} returned JSON that is not a recognized signature report (exit code ${exitCode}); `
      + 'expected non-negative integer "audited" and "verified" fields with "missing" and "invalid" arrays',
    );
  }

  if (report.invalid.length > 0) {
    return reject(
      'invalid-signatures',
      `${command} reported ${report.invalid.length} package(s) with an invalid registry signature `
      + `(exit code ${exitCode}): ${describeFindings(report.invalid)}`,
    );
  }

  if (report.missing.length > 0) {
    return reject(
      'missing-signatures',
      `${command} reported ${report.missing.length} package(s) with no registry signature `
      + `(exit code ${exitCode}): ${describeFindings(report.missing)}`,
    );
  }

  // Placed after the invalid/missing checks on purpose: a failed packument request can push an
  // entry onto `invalid` without incrementing `audited`, so checking the sum first would mask a
  // real signature failure behind a generic arithmetic mismatch.
  const classified = report.verified + report.missing.length + report.invalid.length;
  if (classified !== report.audited) {
    return reject(
      'count-mismatch',
      `${command} reported ${report.audited} audited package(s) but classified ${classified} `
      + `(verified ${report.verified}, missing ${report.missing.length}, invalid ${report.invalid.length})`,
    );
  }

  if (exitCode !== 0) {
    return reject(
      'unexpected-exit',
      `${command} reported ${report.verified} verified package(s) and no finding but exited with code ${exitCode}`,
    );
  }

  // pnpm skips every package whose registry publishes no signing keys, without
  // counting it anywhere. A report that audited nothing therefore exits 0 while
  // proving nothing at all, which is the fail-open case this guard must catch.
  if (report.audited === 0) {
    return reject(
      'nothing-audited',
      `${command} audited no packages: no installed package resolved to a registry that publishes `
      + 'signing keys, so no signature was verified',
    );
  }

  return { kind: 'verified', report, exitCode };
}

/**
 * Diagnostics go to stderr; stdout carries the verdict line only on success — the same
 * discipline `src/tools/verifyVsix.ts` documents — so a rejected run leaves stdout empty
 * rather than let a piped consumer's exit status come from something else.
 */
export async function runSignatureAuditCli(
  argv: readonly string[],
  deps: SignatureAuditCliDependencies,
): Promise<number> {
  try {
    parseSignatureAuditArgs(argv);
  }
  catch (error) {
    deps.writeError(`Signature audit failed: ${describeError(error)}`);
    return 1;
  }

  let execution: SignatureAuditExecution;
  try {
    execution = await deps.runAudit();
  }
  catch (error) {
    deps.writeError(`Signature audit failed: ${describeError(error)}`);
    return 1;
  }

  const outcome = evaluateSignatureAudit(execution);
  if (outcome.kind === 'rejected') {
    deps.writeError(`Signature audit failed [${outcome.reason}]: ${outcome.detail}`);
    return 1;
  }

  deps.writeOut(
    `${outcome.report.verified} of ${outcome.report.audited} audited package(s) `
    + 'have a verified registry signature',
  );
  return 0;
}