import path from 'node:path';
import { METADATA_REQUEST_TIMEOUT_MS, METADATA_RESPONSE_MAX_BYTES } from '../../config';
import { isValidPackageName, PACKAGE_MANAGERS } from '../../shared';
import type { PackageManager } from '../../shared';
import { mapSchemaResult } from '../metadataRunner';
import type { MetadataSchemaResult } from '../metadataRunner';
import type { MetadataRequest, PackageMetadata, PackageMetadataOutcome } from '../metadataRegistry';
import { runBoundedProcess } from '../processRunner';
import type { BoundedProcessOutcome } from '../processRunner';

export type CliRequestCheck<M extends PackageManager>
  = | { kind: 'ready'; packageManager: M; packageRoot: string }
    | { kind: 'rejected'; outcome: PackageMetadataOutcome };

/** Accepts a request for one of the given managers with a package file and a valid package name. */
export function checkCliMetadataRequest<M extends PackageManager>(
  request: MetadataRequest,
  managers: readonly M[],
): CliRequestCheck<M> {
  const packageManager = managers.find(manager => manager === request.packageManager);
  if (packageManager === undefined || request.packageFilePath === undefined || request.packageFilePath === '') {
    return { kind: 'rejected', outcome: { kind: 'transport-error', reason: 'process-failed' } };
  }
  if (!isValidPackageName(request.packageName)) {
    return { kind: 'rejected', outcome: { kind: 'unrecognized' } };
  }
  return { kind: 'ready', packageManager, packageRoot: path.resolve(path.dirname(request.packageFilePath)) };
}

/** Runs a manager's metadata argv (ending in `--`) followed by the package name and maps the outcome. */
export async function runCliMetadata(
  request: MetadataRequest,
  packageManager: PackageManager,
  argv: readonly string[],
  packageRoot: string,
  parse: (json: unknown) => MetadataSchemaResult<PackageMetadata>,
): Promise<PackageMetadataOutcome> {
  const outcome = await runBoundedProcess(PACKAGE_MANAGERS[packageManager].bin, [...argv, request.packageName], {
    cwd: packageRoot,
    timeoutMs: METADATA_REQUEST_TIMEOUT_MS,
    maxBufferBytes: METADATA_RESPONSE_MAX_BYTES,
    signal: request.signal,
  });
  return mapProcessOutcome(outcome, parse);
}

function mapProcessOutcome(
  outcome: BoundedProcessOutcome,
  parse: (json: unknown) => MetadataSchemaResult<PackageMetadata>,
): PackageMetadataOutcome {
  switch (outcome.kind) {
    case 'exit':
      return outcome.exitCode === 0
        ? parseCliOutput(outcome.stdout, parse)
        : { kind: 'transport-error', reason: 'process-failed' };
    case 'timeout':
      return { kind: 'timeout', timeoutMs: outcome.timeoutMs };
    case 'aborted':
      return { kind: 'aborted' };
    case 'overflow':
      return { kind: 'overflow', maxBufferBytes: outcome.maxBufferBytes };
    case 'spawn-error':
      return { kind: 'transport-error', reason: outcome.reason };
  }
}

function parseCliOutput(
  stdout: string,
  parse: (json: unknown) => MetadataSchemaResult<PackageMetadata>,
): PackageMetadataOutcome {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim()) as unknown;
  }
  catch {
    return { kind: 'malformed', reason: 'json' };
  }
  return mapSchemaResult(parse(json));
}