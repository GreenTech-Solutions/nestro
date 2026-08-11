/**
 * `audit:signatures` guard.
 *
 * pnpm only implements the `audit signatures` subcommand from 11.1.0 onwards.
 * Earlier releases accept the positional argument and discard it, so the run
 * silently degrades into the ordinary vulnerability advisory audit: on
 * pnpm 11.0.8 `pnpm audit signatures`, `pnpm audit --audit-level high` and
 * `pnpm audit definitely-not-a-subcommand` all print the same advisory result
 * and exit 0. A step named "signature audit" was therefore green without a
 * single signature ever being checked.
 *
 * This guard decides on the shape of the report the command actually produced,
 * never on the name of the command that produced it. Only the documented
 * signature schema, consistent with itself and with its own exit code, counts
 * as a pass; an advisory report, an unknown schema, empty output, or a report
 * that ended up auditing nothing are all rejections. There is deliberately no
 * pnpm version check: the output contract is the thing that must hold, and a
 * version comparison would re-introduce exactly the "trust the label" mistake
 * this guard exists to remove.
 *
 * Known boundary, measured rather than assumed: `audited` is a floor, not a
 * total. pnpm drops packages out of the denominator one by one and silently —
 * a packument that answers 404 (unpublished package, or a private scope the
 * token cannot read) and a registry that publishes no signing keys both leave
 * the report self-consistent and the exit code 0. A verified verdict therefore
 * proves that every package pnpm actually asked about carries a good signature,
 * and says nothing about packages it never asked about. Only the degenerate
 * case, a report that audited nothing at all, is rejected here. Closing the gap
 * needs an independent count of the packages that should have been audited, and
 * this command does not carry one: its own human-readable output only echoes
 * `audited` back. The advisory audit does publish such a total
 * (`metadata.totalDependencies`, counted from the same lockfile walk), but it is
 * a second command with its own failure modes — against a registry that serves
 * signing keys and no advisory endpoint it fails outright, which is exactly the
 * configuration where the signature denominator shrinks. Cross-checking one
 * command against the other therefore belongs to the CI step that owns the
 * release boundary, not to this guard.
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
 * pnpm is spawned from `PATH` on purpose: pnpm 11 reads the `packageManager`
 * pin and self-switches to it, and `pnpm/action-setup` installs that same
 * pinned version in CI, so both paths audit with the version the repository
 * declares. Windows exposes the launcher as a `.cmd` shim, which `execFile`
 * cannot start without the extension.
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
 * Recognizes the two documented npm/pnpm advisory shapes, the same pair
 * `src/utils/auditClient.ts` accepts. This is what pnpm below 11.1 returns for
 * `audit signatures`, so naming it separately turns the original defect into a
 * specific diagnosis instead of a generic "unknown schema".
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

  // Backstop for a report whose own numbers disagree, deliberately placed after
  // the two named diagnoses above rather than before them.
  //
  // pnpm can classify a package without counting it: when the packument request
  // fails with anything other than a 404, the entry is pushed onto `invalid`
  // from a catch block that never reaches the `audited++` on the success path,
  // so one failed request makes `classified` exceed `audited`. Checking the sum
  // first would answer a real signature failure with arithmetic and swallow the
  // package names — worst in exactly the run that matters most, where some
  // packages could not be checked and others checked badly. Reaching this branch
  // with both finding lists empty means the counts disagree on their own, which
  // no observed pnpm path produces; it stays a rejection because an unexplained
  // report is not proof.
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
 * Runs the guard and returns the process exit code.
 *
 * Diagnostics go to stderr and stdout carries the verdict line only on success,
 * the same discipline `src/tools/verifyVsix.ts` documents: a consumer that
 * pipes this command takes its status from the last process in the pipe, so a
 * rejected run must leave stdout empty rather than let a grep answer for it.
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