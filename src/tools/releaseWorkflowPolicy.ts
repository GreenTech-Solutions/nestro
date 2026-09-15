import { isDeepStrictEqual } from 'node:util';
import { parseDocument, visit } from 'yaml';
import { validatePrepareReleaseConfig } from './releaseAnalyzer';

export const RELEASE_PREPARE_WORKFLOW_PATH = '.github/workflows/release-prepare.yml';
export const RELEASE_CANDIDATE_WORKFLOW_PATH = '.github/workflows/release-candidate.yml';
export const RELEASE_DISPATCH_WORKFLOW_PATH = '.github/workflows/release-dispatch.yml';
export const RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml';
export const RELEASE_CONFIG_PATH = '.releaserc.json';

export interface ReleaseWorkflowPolicyViolation {
  readonly rule: string;
  readonly message: string;
}

type UnknownRecord = Record<string, unknown>;

const SOURCE_SHA_EXPRESSION = '${{ github.event.workflow_run.head_sha }}';
const SOURCE_RUN_ID_EXPRESSION = '${{ github.event.workflow_run.id }}';
const CANDIDATE_ACTIONS = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  download: 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  node: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  pnpm: 'pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2',
  upload: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
} as const;
const PUBLISH_ACTION = 'HaaLeo/publish-vscode-extension@ca5561daa085dee804bf9f37fe0165785a9b14db';
const PREPARE_TRIGGER = {
  workflow_run: {
    types: ['completed'],
    workflows: ['Verify'],
  },
} as const;
const CANDIDATE_TRIGGER = PREPARE_TRIGGER;
const DISPATCH_TRIGGER = {
  workflow_run: {
    types: ['completed'],
    workflows: ['Release candidate'],
  },
} as const;
const PUBLISH_TRIGGER = {
  workflow_dispatch: {
    inputs: {
      artifact_id: {
        description: 'Immutable release candidate artifact ID',
        required: true,
        type: 'string',
      },
      candidate_run_id: {
        description: 'Release candidate workflow run ID',
        required: true,
        type: 'string',
      },
    },
  },
} as const;
const PREPARE_RUN_FILTER = 'github.event.workflow_run.event == \'push\' && github.event.workflow_run.head_branch == \'master\' && github.event.workflow_run.conclusion == \'success\'';
const CANDIDATE_RUN_FILTER = PREPARE_RUN_FILTER;
const DISPATCH_RUN_FILTER = 'github.event.workflow_run.conclusion == \'success\' && github.event.workflow_run.head_branch == \'master\'';
const PUBLISH_RUN_FILTER = 'startsWith(github.ref, \'refs/tags/v\')';

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function add(violations: ReleaseWorkflowPolicyViolation[], rule: string, message: string): void {
  violations.push({ rule, message });
}

function keys(value: UnknownRecord | undefined): string[] {
  return value === undefined ? [] : Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function exactKeys(value: UnknownRecord | undefined, expected: readonly string[]): boolean {
  return JSON.stringify(keys(value)) === JSON.stringify([...expected].sort((left, right) => left.localeCompare(right)));
}

function normalizedRun(step: UnknownRecord): string {
  return asString(step.run)?.trim().replaceAll('\r\n', '\n') ?? '';
}

function executableRun(step: UnknownRecord): string {
  return normalizedRun(step)
    .split('\n')
    .filter(line => !/^\s*#/u.test(line))
    .join('\n');
}

const POST_PUBLISH_COMPARE_RUN = [
  'set -euo pipefail',
  'package_json="$(unzip -p "$CANDIDATE_VSIX" extension/package.json)"',
  'publisher="$(jq -er \'.publisher\' <<<"$package_json")"',
  'name="$(jq -er \'.name\' <<<"$package_json")"',
  '[[ "$publisher" =~ ^[A-Za-z0-9._-]+$ ]]',
  '[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]]',
  '[[ "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
  'mkdir -p dist/published',
  'marketplace_url="https://marketplace.visualstudio.com/_apis/public/gallery/publishers/$publisher/vsextensions/$name/$VERSION/vspackage"',
  'openvsx_url="https://open-vsx.org/api/$publisher/$name/$VERSION/file/$name-$VERSION.vsix"',
  'curl_args=(',
  '  --fail --silent --show-error --location',
  '  --proto \'=https\' --proto-redir \'=https\' --max-redirs 3',
  '  --connect-timeout 10 --max-time 120 --max-filesize 2097152',
  '  --retry 5 --retry-all-errors --retry-max-time 180',
  ')',
  'curl "${curl_args[@]}" "$marketplace_url" --output dist/published/marketplace.vsix',
  'curl "${curl_args[@]}" "$openvsx_url" --output dist/published/openvsx.vsix',
  'test "$(wc -c < dist/published/marketplace.vsix)" -le 2097152',
  'test "$(wc -c < dist/published/openvsx.vsix)" -le 2097152',
  'python3 - "$CANDIDATE_VSIX" dist/published/marketplace.vsix dist/published/openvsx.vsix <<\'PY\'',
  'import hashlib',
  'import json',
  'import stat',
  'import sys',
  'import xml.etree.ElementTree as ET',
  'import zipfile',
  '',
  'MAX_ENTRIES = 26',
  'MAX_COMPRESSED_BYTES = 2097152',
  'MAX_ENTRY_BYTES = 5242880',
  'MAX_UNCOMPRESSED_BYTES = 10485760',
  '',
  'def fail(message):',
  '    raise SystemExit(message)',
  '',
  'def inspect(path):',
  '    try:',
  '        with zipfile.ZipFile(path) as archive:',
  '            entries = []',
  '            seen = set()',
  '            infos = archive.infolist()',
  '            if len(infos) > MAX_ENTRIES:',
  '                fail(f"published VSIX has too many entries: {len(infos)}")',
  '            compressed_total = sum(info.compress_size for info in infos)',
  '            uncompressed_total = sum(info.file_size for info in infos)',
  '            if compressed_total > MAX_COMPRESSED_BYTES:',
  '                fail(f"published VSIX compressed payload exceeds {MAX_COMPRESSED_BYTES} bytes")',
  '            if uncompressed_total > MAX_UNCOMPRESSED_BYTES:',
  '                fail(f"published VSIX expanded payload exceeds {MAX_UNCOMPRESSED_BYTES} bytes")',
  '            for info in infos:',
  '                if info.file_size > MAX_ENTRY_BYTES:',
  '                    fail(f"published VSIX entry is too large: {info.filename}")',
  '                name = info.filename',
  '                if (not name or name.startswith("/") or "\\\\" in name',
  '                        or any(part in ("", "..") for part in name.split("/"))',
  '                        or name.endswith("/")):',
  '                    fail(f"unsafe published archive path: {name}")',
  '                if name in seen:',
  '                    fail(f"duplicate published archive path: {name}")',
  '                seen.add(name)',
  '                mode = (info.external_attr >> 16) & 0xffff',
  '                if stat.S_IFMT(mode) == stat.S_IFLNK:',
  '                    fail(f"published archive contains a symlink: {name}")',
  '                entries.append((name, archive.read(info)))',
  '    except (OSError, zipfile.BadZipFile, RuntimeError, ValueError) as error:',
  '        fail(f"unsafe published VSIX: {error}")',
  '    by_name = dict(entries)',
  '    try:',
  '        package = json.loads(by_name["extension/package.json"])',
  '    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:',
  '        fail(f"published package manifest is invalid: {error}")',
  '    identity = tuple(package.get(key) for key in ("name", "version", "publisher"))',
  '    if any(not isinstance(value, str) or not value for value in identity):',
  '        fail("published package manifest identity is incomplete")',
  '    outer = by_name.get("extension.vsixmanifest")',
  '    if outer is None or b"<!DOCTYPE" in outer.upper() or b"<!ENTITY" in outer.upper():',
  '        fail("published outer manifest is missing or contains forbidden declarations")',
  '    try:',
  '        root = ET.fromstring(outer)',
  '        metadata = next(child for child in root if child.tag.rsplit("}", 1)[-1] == "Metadata")',
  '        identity_node = next(child for child in metadata if child.tag.rsplit("}", 1)[-1] == "Identity")',
  '    except (ET.ParseError, StopIteration) as error:',
  '        fail(f"published outer manifest identity is invalid: {error}")',
  '    outer_identity = (identity_node.attrib.get("Id"), identity_node.attrib.get("Version"), identity_node.attrib.get("Publisher"))',
  '    if outer_identity != identity:',
  '        fail("published VSIX package and outer identities differ")',
  '    normalized = "".join(',
  '        f"{hashlib.sha256(content).hexdigest()}  {name}\\n"',
  '        for name, content in sorted(entries)',
  '    )',
  '    with open(path, "rb") as handle:',
  '        raw = handle.read()',
  '    return raw, identity, normalized',
  '',
  'candidate, candidate_identity, candidate_manifest = inspect(sys.argv[1])',
  'for registry_path in sys.argv[2:]:',
  '    published, published_identity, published_manifest = inspect(registry_path)',
  '    if published == candidate:',
  '        print(f"{registry_path}: exact candidate bytes")',
  '    elif published_identity == candidate_identity and published_manifest == candidate_manifest:',
  '        print(f"{registry_path}: accepted explicit registry re-pack")',
  '    else:',
  '        fail(f"{registry_path}: registry copy does not match candidate identity and normalized manifest")',
  'PY',
].join('\n');

const FINALIZER_TAG_VERIFY_RUN = [
  'set -euo pipefail',
  'candidate=dist/release-candidate/candidate.json',
  'version="$(jq -r \'.version\' "$candidate")"',
  'source_sha="$(jq -r \'.sourceSha\' "$candidate")"',
  'vsix_file="$(jq -r \'.vsixFile\' "$candidate")"',
  'test "$GITHUB_REF" = "refs/tags/v$version"',
  'tag_json="$(gh api "repos/${{ github.repository }}/git/ref/tags/v$version")"',
  'test "$(jq -r \'.object.type\' <<<"$tag_json")" = commit',
  'test "$(jq -r \'.object.sha\' <<<"$tag_json")" = "$source_sha"',
  'sha256sum --check --strict "dist/release-candidate/$vsix_file.sha256"',
  'expected_members="$(printf \'%s\\n\' "$vsix_file" "$vsix_file.manifest.txt" "$vsix_file.sha256" sbom.json provenance.json candidate.json | sort)"',
  'actual_members="$(find dist/release-candidate -maxdepth 1 -type f -printf \'%f\\n\' | sort)"',
  'test "$actual_members" = "$expected_members"',
  'test "$(sha256sum "dist/release-candidate/$vsix_file.manifest.txt" | cut -d \' \' -f 1)" = "$(jq -r \'.manifestSha256\' "$candidate")"',
  'test "$(sha256sum dist/release-candidate/sbom.json | cut -d \' \' -f 1)" = "$(jq -r \'.sbomSha256\' "$candidate")"',
  'test "$(sha256sum dist/release-candidate/provenance.json | cut -d \' \' -f 1)" = "$(jq -r \'.provenanceSha256\' "$candidate")"',
  'jq -r \'.notes\' "$candidate" > dist/release-candidate/notes.md',
  '{',
  '  echo "tag=v$version"',
  '  echo "vsix-file=$vsix_file"',
  '} >> "$GITHUB_OUTPUT"',
].join('\n');

const FINALIZER_CREATE_RELEASE_RUN = [
  'set -euo pipefail',
  'if gh release view "$TAG" >/dev/null 2>&1; then',
  '  echo \'already-released=true\' >> "$GITHUB_OUTPUT"',
  '  exit 0',
  'fi',
  'gh release create "$TAG" \\',
  '  "dist/release-candidate/$VSIX_FILE" \\',
  '  "dist/release-candidate/$VSIX_FILE.manifest.txt" \\',
  '  "dist/release-candidate/$VSIX_FILE.sha256" \\',
  '  dist/release-candidate/sbom.json \\',
  '  dist/release-candidate/provenance.json \\',
  '  dist/release-candidate/candidate.json \\',
  '  --notes-file dist/release-candidate/notes.md \\',
  '  --title "$TAG" \\',
  '  --verify-tag',
  'echo \'already-released=false\' >> "$GITHUB_OUTPUT"',
].join('\n');

const FINALIZER_EXISTING_RELEASE_RUN = [
  'set -euo pipefail',
  'release="$(gh api "repos/${{ github.repository }}/releases/tags/$TAG")"',
  'test "$(jq -r \'.tag_name\' <<<"$release")" = "$TAG"',
  'mkdir -p dist/existing-release',
  'expected_names="$(printf \'%s\\n\' candidate.json "$VSIX_FILE" "$VSIX_FILE.manifest.txt" "$VSIX_FILE.sha256" sbom.json provenance.json | sort)"',
  'unexpected_names="$(jq -r \'.assets[].name\' <<<"$release" | sort | comm -23 - <(printf \'%s\\n\' "$expected_names"))"',
  'test -z "$unexpected_names"',
  'while IFS= read -r name; do',
  '  if jq -e --arg name "$name" \'.assets[] | select(.name == $name)\' <<<"$release" >/dev/null; then',
  '    gh release download "$TAG" --dir dist/existing-release --pattern "$name"',
  '    cmp "dist/release-candidate/$name" "dist/existing-release/$name"',
  '  else',
  '    gh release upload "$TAG" "dist/release-candidate/$name"',
  '  fi',
  'done <<<"$expected_names"',
  'release="$(gh api "repos/${{ github.repository }}/releases/tags/$TAG")"',
  'asset_names="$(jq -r \'.assets[].name\' <<<"$release" | sort)"',
  'test "$asset_names" = "$expected_names"',
].join('\n');

function isFailClosedShellStep(step: UnknownRecord): boolean {
  const run = executableRun(step);
  const firstLine = run.split('\n').find(line => line.trim().length > 0)?.trim();
  return firstLine === 'set -euo pipefail'
    && !/\|\||\bset\s+\+[eu]\b|\bset\s+\+o\b|\btrap\b/u.test(run);
}

function assertFailClosedShellSteps(
  job: UnknownRecord | undefined,
  rule: string,
  violations: ReleaseWorkflowPolicyViolation[],
): void {
  if (steps(job).some(step => asString(step.run) !== undefined && !isFailClosedShellStep(step))) {
    add(violations, rule, 'security-sensitive shell steps must fail closed with strict error handling');
  }
}

function steps(job: UnknownRecord | undefined): UnknownRecord[] {
  return Array.isArray(job?.steps) ? job.steps.filter(isRecord) : [];
}

function findStep(job: UnknownRecord | undefined, name: string): UnknownRecord | undefined {
  return steps(job).find(step => step.name === name);
}

function assertStepNames(
  job: UnknownRecord | undefined,
  expected: readonly string[],
  rule: string,
  violations: ReleaseWorkflowPolicyViolation[],
): void {
  const actual = steps(job).map(step => asString(step.name) ?? '');
  if (!isDeepStrictEqual(actual, expected)) {
    add(violations, rule, 'release jobs must contain only the reviewed executable steps in order');
  }
}

function hasRun(job: UnknownRecord | undefined, predicate: (run: string, step: UnknownRecord) => boolean): boolean {
  return steps(job).some(step => predicate(executableRun(step), step));
}

function hasAction(job: UnknownRecord | undefined, reference: string): UnknownRecord | undefined {
  return steps(job).find(step => step.uses === reference);
}

function hasSecretReference(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\bsecrets\.(?:VSCE_PAT|OVSX_PAT|VSCE_TOKEN|OPEN_VSX_TOKEN)\b/u.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasSecretReference);
  }
  if (isRecord(value)) {
    return Object.entries(value).some(([key, entry]) => /^(?:VSCE_PAT|OVSX_PAT|VSCE_TOKEN|OPEN_VSX_TOKEN)$/u.test(key)
      || hasSecretReference(entry));
  }
  return false;
}

function publishStepsWithSecrets(job: UnknownRecord | undefined): UnknownRecord[] {
  return steps(job).filter(hasSecretReference);
}

function parseWorkflow(source: string): { root: UnknownRecord; violations: ReleaseWorkflowPolicyViolation[] } {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return { root: {}, violations: document.errors.map(error => ({ rule: 'yaml', message: error.message })) };
  }
  let containsNonLiteralYaml = false;
  visit(document, {
    Alias: () => {
      containsNonLiteralYaml = true;
    },
    Node: (_key, node) => {
      if (isRecord(node) && typeof node.anchor === 'string') {
        containsNonLiteralYaml = true;
      }
    },
  });
  if (containsNonLiteralYaml) {
    return {
      root: {},
      violations: [{ rule: 'yaml', message: 'release workflows must not use YAML anchors or aliases' }],
    };
  }
  try {
    const value = document.toJS();
    if (!isRecord(value)) {
      return { root: {}, violations: [{ rule: 'workflow-shape', message: 'workflow must be a mapping' }] };
    }
    return { root: value, violations: [] };
  }
  catch (error) {
    return {
      root: {},
      violations: [{
        rule: 'yaml',
        message: `release workflow could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }
}

function assertTrigger(
  root: UnknownRecord,
  expected: Readonly<Record<string, unknown>>,
  violations: ReleaseWorkflowPolicyViolation[],
): void {
  const trigger = asRecord(root.on);
  if (!isDeepStrictEqual(trigger, expected)) {
    add(violations, 'release-trigger', 'release workflow must consume only the reviewed completed workflow_run');
  }
}

function assertExactWorkflowRoot(
  root: UnknownRecord,
  expectedName: string,
  expectedRootKeys: readonly string[],
  violations: ReleaseWorkflowPolicyViolation[],
): void {
  if (root.name !== expectedName || !exactKeys(root, expectedRootKeys)) {
    add(violations, 'release-workflow-contract', `${expectedName} must use the exact reviewed workflow shape`);
  }
}

function assertCompletedRunIdentity(
  job: UnknownRecord | undefined,
  expectedFilter: string,
  violations: ReleaseWorkflowPolicyViolation[],
  expectedEvent = 'push',
): void {
  if (job?.if !== `\${{ ${expectedFilter} }}`) {
    add(violations, 'release-run-identity', 'release jobs must run only for a successful master verification run');
  }
  const check = steps(job).find(step => executableRun(step).includes('actions/runs/')
    && executableRun(step).includes('.head_sha')
    && executableRun(step).includes('.head_branch')
    && executableRun(step).includes('.event')
    && executableRun(step).includes('.conclusion'));
  if (check === undefined) {
    add(violations, 'release-run-identity', 'release jobs must re-check the completed run through the GitHub API');
    return;
  }
  const run = executableRun(check);
  if (!run.includes('SOURCE_SHA') || !run.includes('master') || !run.includes(expectedEvent) || !run.includes('success')) {
    add(violations, 'release-run-identity', 'release API checks must bind the exact source, branch, event and conclusion');
  }
}

function assertNoForbiddenSecrets(root: UnknownRecord, violations: ReleaseWorkflowPolicyViolation[]): void {
  if (hasSecretReference(root)) {
    add(violations, 'secret-boundary', 'preparation and candidate workflows must not reference publishing credentials');
  }
}

function assertNoMerge(job: UnknownRecord | undefined, violations: ReleaseWorkflowPolicyViolation[]): void {
  if (hasRun(job, run => /\bgh\s+pr\s+merge\b|enablePullRequestAutoMerge|\/merge\b/u.test(run))) {
    add(violations, 'no-merge', 'preparation must create a reviewable pull request but never merge it');
  }
}

export function evaluateReleasePrepareWorkflowPolicy(source: string): ReleaseWorkflowPolicyViolation[] {
  const parsed = parseWorkflow(source);
  const violations = [...parsed.violations];
  if (violations.length > 0) {
    return violations;
  }
  const root = parsed.root;
  assertExactWorkflowRoot(root, 'Release prepare', ['concurrency', 'env', 'jobs', 'name', 'on', 'permissions'], violations);
  assertTrigger(root, PREPARE_TRIGGER, violations);
  if (!isDeepStrictEqual(root.permissions, { actions: 'write', contents: 'write', 'pull-requests': 'write' })) {
    add(violations, 'least-permissions', 'preparation must have only actions, contents and pull-requests write permissions');
  }
  const concurrency = asRecord(root.concurrency);
  if (!isDeepStrictEqual(concurrency, { 'cancel-in-progress': false, group: 'release-prepare' })) {
    add(violations, 'retry-safety', 'preparation must serialize retries without cancelling an active run');
  }
  const env = asRecord(root.env);
  if (env?.SOURCE_SHA !== SOURCE_SHA_EXPRESSION || env?.SOURCE_CI_RUN_ID !== SOURCE_RUN_ID_EXPRESSION
    || typeof env.RELEASE_REPOSITORY_URL !== 'string') {
    add(violations, 'source-identity', 'preparation must bind source SHA and verification run ID from workflow_run');
  }
  const jobs = asRecord(root.jobs);
  if (!exactKeys(jobs, ['prepare'])) {
    add(violations, 'job-allowlist', 'preparation must contain only the preparation job');
  }
  const job = asRecord(jobs?.prepare);
  if (job?.name !== 'Prepare the version pull request'
    || job['runs-on'] !== 'ubuntu-latest'
    || !isDeepStrictEqual(job.permissions, { actions: 'write', contents: 'write', 'pull-requests': 'write' })) {
    add(violations, 'job-contract', 'preparation must use the least scoped write-capable job');
  }
  assertCompletedRunIdentity(job, PREPARE_RUN_FILTER, violations);
  assertNoForbiddenSecrets(root, violations);
  assertNoMerge(job, violations);
  assertStepNames(job, [
    'Verify the completed verification run',
    'Checkout the exact tested commit',
    'Assert checkout identity',
    'Reject a stale master',
    'Reject competing release pull requests',
    'Prepare pnpm',
    'Setup Node.js',
    'Install frozen dependencies',
    'Analyze and prepare the next release',
    'Create the version pull request',
    'Resolve the exact version pull request',
    'Dispatch exact-head verification for the version pull request',
  ], 'step-allowlist', violations);
  const checkout = hasAction(job, CANDIDATE_ACTIONS.checkout);
  const checkoutOptions = asRecord(checkout?.with);
  if (!exactKeys(checkoutOptions, ['fetch-depth', 'persist-credentials', 'ref'])
    || checkoutOptions?.ref !== '${{ env.SOURCE_SHA }}'
    || checkoutOptions['fetch-depth'] !== 0
    || checkoutOptions['persist-credentials'] !== true) {
    add(violations, 'exact-checkout', 'preparation must checkout the verified source SHA with write credentials only for its PR branch');
  }
  if (!hasRun(job, run => run === 'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"')) {
    add(violations, 'exact-checkout', 'preparation must assert the checked-out source SHA');
  }
  if (!hasRun(job, run => run.includes('git rev-parse origin/master') && run.includes('SOURCE_SHA'))) {
    add(violations, 'stale-master', 'preparation must reject a stale master before creating a release branch');
  }
  const competing = findStep(job, 'Reject competing release pull requests');
  if (competing === undefined
    || !normalizedRun(competing).includes('gh pr list')
    || !normalizedRun(competing).includes('more than one open release pull request exists')
    || !normalizedRun(competing).includes('.parents[0].sha')
    || !normalizedRun(competing).includes('SOURCE_SHA')
    || !normalizedRun(competing).includes('$\'CHANGELOG.md\\npackage.json\'')) {
    add(violations, 'duplicate-version-pr', 'preparation must reject competing, stale or non-canonical version pull requests');
  }
  const analyze = findStep(job, 'Analyze and prepare the next release');
  if (analyze === undefined || normalizedRun(analyze) !== 'pnpm run release:prepare -- --out-dir dist/release'
    || asRecord(analyze.env)?.RELEASE_CONFIG !== RELEASE_CONFIG_PATH) {
    add(violations, 'isolated-analysis', 'preparation must use the isolated analyze-and-notes configuration');
  }
  if (!hasRun(job, run => run.includes('git add package.json CHANGELOG.md') && run.includes('git commit -m "ci(release): prepare v$version"'))) {
    add(violations, 'version-pr', 'preparation must commit only package.json and CHANGELOG.md on the version branch');
  }
  if (!hasRun(job, run => run.includes('git push origin "$branch"') && run.includes('gh pr create --base master'))) {
    add(violations, 'version-pr', 'preparation must push and open a version pull request');
  }
  const resolvePullRequest = findStep(job, 'Resolve the exact version pull request');
  const resolvePullRequestEnv = asRecord(resolvePullRequest?.env);
  if (resolvePullRequest === undefined
    || resolvePullRequestEnv?.EXISTING_HEAD_SHA !== '${{ steps.existing.outputs.head-sha }}'
    || resolvePullRequestEnv?.IS_EXISTING !== '${{ steps.existing.outputs.is-existing }}'
    || !normalizedRun(resolvePullRequest).includes('test "$head_sha" = "$EXISTING_HEAD_SHA"')) {
    add(violations, 'dispatch-identity', 'preparation must bind the final PR read to the already validated existing head SHA');
  }
  const dispatch = findStep(job, 'Dispatch exact-head verification for the version pull request');
  if (dispatch === undefined
    || !normalizedRun(dispatch).includes('gh workflow run ci.yml --ref "$PR_BRANCH"')
    || !normalizedRun(dispatch).includes('-f "pr_number=$PR_NUMBER"')
    || !normalizedRun(dispatch).includes('-f "head_sha=$PR_HEAD_SHA"')) {
    add(violations, 'dispatch-identity', 'preparation must explicitly dispatch verification for the exact PR number and head SHA');
  }
  return violations;
}

export function evaluateReleaseCandidateWorkflowPolicy(source: string): ReleaseWorkflowPolicyViolation[] {
  const parsed = parseWorkflow(source);
  const violations = [...parsed.violations];
  if (violations.length > 0) {
    return violations;
  }
  const root = parsed.root;
  assertExactWorkflowRoot(root, 'Release candidate', ['env', 'jobs', 'name', 'on', 'permissions'], violations);
  assertTrigger(root, CANDIDATE_TRIGGER, violations);
  if (!isRecord(root.permissions) || keys(asRecord(root.permissions)).length !== 0) {
    add(violations, 'least-permissions', 'candidate workflow must start with no write permissions');
  }
  const env = asRecord(root.env);
  if (env?.SOURCE_SHA !== SOURCE_SHA_EXPRESSION || env?.SOURCE_CI_RUN_ID !== SOURCE_RUN_ID_EXPRESSION) {
    add(violations, 'source-identity', 'candidate workflow must bind the verified source SHA and run ID');
  }
  const jobs = asRecord(root.jobs);
  if (!exactKeys(jobs, ['candidate'])) {
    add(violations, 'job-allowlist', 'candidate workflow must contain only the candidate job');
  }
  const job = asRecord(jobs?.candidate);
  if (job?.name !== 'Build the immutable release candidate'
    || job['runs-on'] !== 'ubuntu-latest'
    || !isDeepStrictEqual(job.permissions, { actions: 'read', contents: 'read' })) {
    add(violations, 'job-contract', 'candidate job must use read-only artifact and source permissions');
  }
  assertCompletedRunIdentity(job, CANDIDATE_RUN_FILTER, violations);
  assertNoForbiddenSecrets(root, violations);
  assertStepNames(job, [
    'Verify the completed verification run',
    'Checkout the exact versioned commit',
    'Assert checkout identity',
    'Prepare pnpm',
    'Setup Node.js',
    'Install frozen dependencies',
    'Download the exact verified evidence',
    'Build the candidate manifest',
    'Upload the immutable candidate',
  ], 'step-allowlist', violations);
  if (hasRun(job, run => /\bgit\s+(push|commit)|\bgh\s+pr\s+merge\b/u.test(run))) {
    add(violations, 'candidate-side-effects', 'candidate workflow must not mutate the repository or merge pull requests');
  }
  const checkout = hasAction(job, CANDIDATE_ACTIONS.checkout);
  const checkoutOptions = asRecord(checkout?.with);
  if (!exactKeys(checkoutOptions, ['fetch-depth', 'persist-credentials', 'ref'])
    || checkoutOptions?.ref !== '${{ env.SOURCE_SHA }}'
    || checkoutOptions['fetch-depth'] !== 0
    || checkoutOptions['persist-credentials'] !== false) {
    add(violations, 'exact-checkout', 'candidate must checkout only the verified source SHA without credentials');
  }
  if (!hasRun(job, run => run === 'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"')) {
    add(violations, 'exact-checkout', 'candidate must assert the checked-out source SHA');
  }
  if (!hasRun(job, run => run === 'pnpm install --frozen-lockfile')) {
    add(violations, 'frozen-install', 'candidate tooling must use the frozen lockfile');
  }
  const download = hasAction(job, CANDIDATE_ACTIONS.download);
  const downloadOptions = asRecord(download?.with);
  if (!exactKeys(downloadOptions, ['github-token', 'name', 'path', 'run-id'])
    || downloadOptions?.['run-id'] !== '${{ github.event.workflow_run.id }}'
    || downloadOptions?.name !== 'verify-evidence-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}'
    || downloadOptions?.path !== 'dist/ci') {
    add(violations, 'exact-artifact', 'candidate must download evidence from the exact completed verification run');
  }
  const buildManifest = findStep(job, 'Build the candidate manifest');
  if (buildManifest === undefined
    || normalizedRun(buildManifest) !== 'pnpm run release:candidate -- --artifact-dir dist/ci --out-dir dist/release-candidate'
    || asRecord(buildManifest.env)?.RELEASE_SOURCE_SHA !== '${{ env.SOURCE_SHA }}'
    || asRecord(buildManifest.env)?.RELEASE_CI_RUN_ID !== '${{ env.SOURCE_CI_RUN_ID }}'
    || asRecord(buildManifest.env)?.RELEASE_CANDIDATE_RUN_ID !== '${{ github.run_id }}') {
    add(violations, 'candidate-manifest', 'candidate manifest must bind source, verification run and candidate run identities');
  }
  const upload = hasAction(job, CANDIDATE_ACTIONS.upload);
  const uploadOptions = asRecord(upload?.with);
  if (!exactKeys(uploadOptions, ['if-no-files-found', 'name', 'overwrite', 'path', 'retention-days'])
    || upload?.if !== '${{ steps.candidate.outputs.is-candidate == \'true\' }}'
    || uploadOptions?.overwrite !== false
    || uploadOptions?.['retention-days'] !== 90
    || typeof uploadOptions?.name !== 'string'
    || uploadOptions.path !== 'dist/release-candidate/*.vsix\ndist/release-candidate/*.vsix.manifest.txt\ndist/release-candidate/*.vsix.sha256\ndist/release-candidate/sbom.json\ndist/release-candidate/provenance.json\ndist/release-candidate/candidate.json\n') {
    add(violations, 'immutable-candidate', 'candidate upload must be immutable, retained and include the exact six-member provenance bundle');
  }
  if (hasRun(job, run => /\bpnpm run build\b|\btsdown\b/u.test(run))) {
    add(violations, 'single-build', 'candidate workflow must not rebuild the VSIX');
  }
  return violations;
}

export function evaluateReleaseDispatchWorkflowPolicy(source: string): ReleaseWorkflowPolicyViolation[] {
  const parsed = parseWorkflow(source);
  const violations = [...parsed.violations];
  if (violations.length > 0) {
    return violations;
  }
  const root = parsed.root;
  assertExactWorkflowRoot(root, 'Release dispatch', ['concurrency', 'env', 'jobs', 'name', 'on', 'permissions'], violations);
  assertTrigger(root, DISPATCH_TRIGGER, violations);
  if (!isRecord(root.permissions) || keys(asRecord(root.permissions)).length !== 0) {
    add(violations, 'least-permissions', 'dispatch workflow must start with no permissions');
  }
  const concurrency = asRecord(root.concurrency);
  if (!isDeepStrictEqual(concurrency, { 'cancel-in-progress': false, group: 'release-dispatch' })) {
    add(violations, 'retry-safety', 'dispatch must serialize retries without cancelling an active run');
  }
  const env = asRecord(root.env);
  if (env?.SOURCE_SHA !== SOURCE_SHA_EXPRESSION || env?.CANDIDATE_RUN_ID !== SOURCE_RUN_ID_EXPRESSION) {
    add(violations, 'source-identity', 'dispatch must bind the candidate source SHA and run ID from workflow_run');
  }
  const jobs = asRecord(root.jobs);
  if (!exactKeys(jobs, ['dispatch'])) {
    add(violations, 'job-allowlist', 'dispatch must contain only the release dispatch job');
  }
  const job = asRecord(jobs?.dispatch);
  const jobEnv = asRecord(job?.env);
  if (job?.name !== 'Tag and dispatch the verified candidate'
    || job['runs-on'] !== 'ubuntu-latest'
    || !isDeepStrictEqual(job.permissions, { actions: 'write', contents: 'write' })
    || !isDeepStrictEqual(jobEnv, {
      GH_REPO: '${{ github.repository }}',
      GH_TOKEN: '${{ github.token }}',
    })) {
    add(violations, 'job-contract', 'dispatch must use the least scoped write-capable job');
  }
  assertCompletedRunIdentity(job, DISPATCH_RUN_FILTER, violations, 'workflow_run');
  assertNoForbiddenSecrets(root, violations);
  assertStepNames(job, [
    'Verify the candidate workflow run',
    'Resolve the exact candidate artifact',
    'Download the exact candidate artifact',
    'Verify the candidate and source run',
    'Create or verify the exact source tag',
    'Dispatch protected publish on the tag',
  ], 'step-allowlist', violations);
  assertNoBuildOrCheckout(job, violations);
  assertFailClosedShellSteps(job, 'fail-closed-shell', violations);
  const artifactResolution = findStep(job, 'Resolve the exact candidate artifact');
  if (artifactResolution === undefined
    || (!executableRun(artifactResolution).includes('/actions/runs/${{ github.event.workflow_run.id }}/artifacts')
      && !executableRun(artifactResolution).includes('/actions/runs/$CANDIDATE_RUN_ID/artifacts'))
    || !executableRun(artifactResolution).includes('release-candidate-')
    || !executableRun(artifactResolution).includes('count')) {
    add(violations, 'exact-artifact', 'dispatch must resolve one candidate artifact from the exact completed candidate run');
  }
  const download = hasAction(job, CANDIDATE_ACTIONS.download);
  const downloadOptions = asRecord(download?.with);
  if (!exactKeys(downloadOptions, ['artifact-ids', 'github-token', 'path', 'run-id'])
    || downloadOptions?.['artifact-ids'] !== '${{ steps.artifact.outputs.id }}'
    || downloadOptions?.['run-id'] !== '${{ github.event.workflow_run.id }}'
    || downloadOptions?.path !== 'dist/release-candidate') {
    add(violations, 'exact-artifact', 'dispatch must download the resolved candidate by immutable artifact ID and run ID');
  }
  const verify = findStep(job, 'Verify the candidate and source run');
  if (verify === undefined
    || !isFailClosedShellStep(verify)
    || !executableRun(verify).includes('.sourceSha')
    || !executableRun(verify).includes('.ciRunId')
    || !executableRun(verify).includes('.ciRunAttempt')
    || !executableRun(verify).includes('.digest')
    || !executableRun(verify).includes('.manifestSha256')
    || !executableRun(verify).includes('.sbomSha256')
    || !executableRun(verify).includes('.provenanceSha256')
    || !executableRun(verify).includes('expected_members')
    || !executableRun(verify).includes('sha256sum --check')) {
    add(violations, 'candidate-integrity', 'dispatch must verify source, candidate run, CI run and every provenance member before tagging');
  }
  const tag = findStep(job, 'Create or verify the exact source tag');
  const tagRun = tag === undefined ? '' : executableRun(tag);
  if (tag === undefined
    || !isFailClosedShellStep(tag)
    || tag.shell !== 'bash'
    || !tagRun.includes('git/ref/tags/')
    || !tagRun.includes('SOURCE_SHA')
    || !tagRun.includes('refs/tags/')) {
    add(violations, 'exact-tag', 'dispatch must create or verify the version tag at the manifest source SHA');
  }
  const releaseDispatch = findStep(job, 'Dispatch protected publish on the tag');
  const releaseDispatchRun = releaseDispatch === undefined ? '' : executableRun(releaseDispatch);
  if (releaseDispatch === undefined
    || !isFailClosedShellStep(releaseDispatch)
    || releaseDispatch.shell !== 'bash'
    || !releaseDispatchRun.includes('gh workflow run release.yml --ref "$TAG"')
    || !releaseDispatchRun.includes('-f "candidate_run_id=$CANDIDATE_RUN_ID"')
    || !releaseDispatchRun.includes('-f "artifact_id=$ARTIFACT_ID"')) {
    add(violations, 'dispatch-identity', 'dispatch must pass the exact candidate run and artifact IDs to release.yml on the version tag');
  }
  return violations;
}

function assertNoBuildOrCheckout(job: UnknownRecord | undefined, violations: ReleaseWorkflowPolicyViolation[]): void {
  const hasForbiddenOperation = (run: string): boolean => run.includes('actions/checkout')
    || /\b(?:pnpm|npm|yarn|bun)\s+(?:ci|install|exec|dlx)\b/u.test(run)
    || /\bnpx\b/u.test(run)
    || /\b(?:pnpm|npm|yarn|bun)\s+run\s+build\b/u.test(run)
    || run.includes('tsdown')
    || /\b(?:git\s+checkout|git\s+clone)\b/u.test(run);
  if (hasAction(job, CANDIDATE_ACTIONS.checkout) !== undefined || hasRun(job, hasForbiddenOperation)) {
    add(violations, 'publish-boundary', 'protected publish and finalizer jobs must not checkout, install or build');
  }
}

export function evaluateReleaseWorkflowPolicy(source: string): ReleaseWorkflowPolicyViolation[] {
  const parsed = parseWorkflow(source);
  const violations = [...parsed.violations];
  if (violations.length > 0) {
    return violations;
  }
  const root = parsed.root;
  assertExactWorkflowRoot(root, 'Release', ['concurrency', 'jobs', 'name', 'on', 'permissions'], violations);
  assertTrigger(root, PUBLISH_TRIGGER, violations);
  if (!isRecord(root.permissions) || keys(asRecord(root.permissions)).length !== 0) {
    add(violations, 'least-permissions', 'release workflow must start with no permissions');
  }
  const concurrency = asRecord(root.concurrency);
  if (!isDeepStrictEqual(concurrency, { 'cancel-in-progress': false, group: 'release' })) {
    add(violations, 'protected-environment', 'release must serialize the protected release group without cancelling it');
  }
  const jobs = asRecord(root.jobs);
  if (!exactKeys(jobs, ['finalize', 'publish'])) {
    add(violations, 'job-allowlist', 'release must contain only publish and finalizer jobs');
  }
  const publish = asRecord(jobs?.publish);
  const finalize = asRecord(jobs?.finalize);
  if (publish?.name !== 'Publish the verified candidate'
    || publish?.['runs-on'] !== 'ubuntu-latest'
    || publish?.environment !== 'release'
    || !isDeepStrictEqual(publish.permissions, { actions: 'read', attestations: 'read', contents: 'read' })) {
    add(violations, 'protected-environment', 'publish must use the release environment and read-only actions, contents and attestations permissions');
  }
  if (publish?.if !== `\${{ ${PUBLISH_RUN_FILTER} }}`) {
    add(violations, 'release-run-identity', 'publish must require a version tag workflow dispatch');
  }
  if (finalize?.name !== 'Finalize the GitHub release'
    || finalize?.needs !== 'publish'
    || finalize?.if !== '${{ needs.publish.outputs.has-candidate == \'true\' }}'
    || finalize?.['runs-on'] !== 'ubuntu-latest'
    || !isDeepStrictEqual(finalize.permissions, { actions: 'read', contents: 'write' })
    || !isDeepStrictEqual(asRecord(finalize.env), {
      GH_REPO: '${{ github.repository }}',
      GH_TOKEN: '${{ github.token }}',
    })) {
    add(violations, 'finalizer-boundary', 'finalizer must run only after publish and use GitHub contents write without registry credentials');
  }
  assertNoForbiddenSecrets(finalize ?? {}, violations);
  if (isRecord(publish?.env) && hasSecretReference(publish.env)) {
    add(violations, 'secret-boundary', 'publish credentials must not be inherited by the publish job');
  }
  const publishOutputs = asRecord(publish?.outputs);
  if (!isDeepStrictEqual(publishOutputs, {
    'artifact-id': '${{ steps.artifact.outputs.id }}',
    'has-candidate': '${{ steps.artifact.outputs.has-candidate }}',
  })) {
    add(violations, 'artifact-outputs', 'publish must expose only the resolved artifact ID and candidate decision');
  }
  assertStepNames(publish, [
    'Verify the candidate workflow run',
    'Resolve the exact candidate artifact',
    'Download the exact candidate artifact',
    'Verify the candidate manifest, tag and digest',
    'Verify protected candidate attestation',
    'Publish to the Visual Studio Marketplace',
    'Publish to Open VSX',
    'Compare post-publish registry copies',
  ], 'step-allowlist', violations);
  assertStepNames(finalize, [
    'Download the exact published candidate',
    'Verify the exact source tag',
    'Create the GitHub release if absent',
    'Verify an existing GitHub release safely',
  ], 'step-allowlist', violations);
  assertNoBuildOrCheckout(publish, violations);
  assertNoBuildOrCheckout(finalize, violations);
  assertFailClosedShellSteps(publish, 'fail-closed-shell', violations);
  assertFailClosedShellSteps(finalize, 'finalizer-boundary', violations);
  if (hasRun(finalize, run => /\bgit\s+(?:push|commit)\b|git\/refs\b.*(?:POST|create)/u.test(run))) {
    add(violations, 'finalizer-boundary', 'finalizer must use the GitHub API without mutating source history or creating tags');
  }
  const dispatchIdentity = findStep(publish, 'Verify the candidate workflow run');
  const dispatchIdentityEnv = asRecord(dispatchIdentity?.env);
  if (dispatchIdentity === undefined
    || dispatchIdentityEnv?.CANDIDATE_RUN_ID !== '${{ inputs.candidate_run_id }}'
    || !normalizedRun(dispatchIdentity).includes('actions/runs/')) {
    add(violations, 'dispatch-identity', 'release must validate the exact candidate workflow run input');
  }
  const artifactResolution = findStep(publish, 'Resolve the exact candidate artifact');
  if (artifactResolution === undefined
    || !isFailClosedShellStep(artifactResolution)
    || !executableRun(artifactResolution).includes('/actions/runs/$CANDIDATE_RUN_ID/artifacts')
    || !executableRun(artifactResolution).includes('ARTIFACT_ID')
    || (!executableRun(artifactResolution).includes('count') && !executableRun(artifactResolution).includes('length'))) {
    add(violations, 'exact-artifact', 'release must resolve the dispatched artifact from the exact candidate workflow run');
  }
  const download = hasAction(publish, CANDIDATE_ACTIONS.download);
  const downloadOptions = asRecord(download?.with);
  if (!exactKeys(downloadOptions, ['artifact-ids', 'github-token', 'path', 'run-id'])
    || downloadOptions?.['artifact-ids'] !== '${{ steps.artifact.outputs.id }}'
    || downloadOptions?.['run-id'] !== '${{ inputs.candidate_run_id }}'
    || downloadOptions?.path !== 'dist/release-candidate') {
    add(violations, 'exact-artifact', 'release must download the dispatched artifact by immutable ID and run ID');
  }
  const verify = findStep(publish, 'Verify the candidate manifest, tag and digest');
  if (verify === undefined
    || !isFailClosedShellStep(verify)
    || !executableRun(verify).includes('.sourceSha')
    || !executableRun(verify).includes('.ciRunId')
    || !executableRun(verify).includes('.candidateRunId')
    || !executableRun(verify).includes('.digest')
    || !executableRun(verify).includes('.ciRunAttempt')
    || !executableRun(verify).includes('.manifestSha256')
    || !executableRun(verify).includes('.sbomSha256')
    || !executableRun(verify).includes('.provenanceSha256')
    || !executableRun(verify).includes('expected_members')
    || !executableRun(verify).includes('sha256sum --check')
    || !executableRun(verify).includes('git/ref/tags/')
    || !executableRun(verify).includes('GITHUB_REF')
    || !executableRun(verify).includes('refs/tags/v')) {
    add(violations, 'candidate-integrity', 'release must verify source, tag, candidate run, CI run and every provenance member before using credentials');
  }
  const attestation = findStep(publish, 'Verify protected candidate attestation');
  const expectedAttestationRun = [
    'set -euo pipefail',
    'gh attestation verify "$VSIX_PATH" \\',
    '  --repo "$GITHUB_REPOSITORY" \\',
    '  --signer-workflow "$GITHUB_REPOSITORY/.github/workflows/ci.yml"',
  ].join('\n');
  if (attestation === undefined
    || attestation.shell !== 'bash'
    || !exactKeys(asRecord(attestation.env), ['GH_TOKEN', 'VSIX_PATH'])
    || asRecord(attestation.env)?.GH_TOKEN !== '${{ github.token }}'
    || asRecord(attestation.env)?.VSIX_PATH !== '${{ steps.manifest.outputs.vsix-path }}'
    || executableRun(attestation) !== expectedAttestationRun) {
    add(violations, 'attestation', 'protected publish must verify the exact VSIX attestation with repository and signer workflow constraints');
  }
  const postPublish = findStep(publish, 'Compare post-publish registry copies');
  const postPublishRun = postPublish === undefined ? '' : executableRun(postPublish);
  if (postPublish === undefined
    || postPublish.shell !== 'bash'
    || !isFailClosedShellStep(postPublish)
    || !exactKeys(asRecord(postPublish.env), ['CANDIDATE_VSIX', 'VERSION'])
    || asRecord(postPublish.env)?.CANDIDATE_VSIX !== '${{ steps.manifest.outputs.vsix-path }}'
    || asRecord(postPublish.env)?.VERSION !== '${{ steps.manifest.outputs.version }}'
    || !postPublishRun.includes('marketplace.visualstudio.com')
    || !postPublishRun.includes('open-vsx.org')
    || postPublishRun !== POST_PUBLISH_COMPARE_RUN
    || !postPublishRun.includes('normalized')
    || !postPublishRun.includes('identity')) {
    add(violations, 'post-publish', 'publish must download and safely compare both registry copies, allowing only an explicit normalized re-pack');
  }
  const marketplace = findStep(publish, 'Publish to the Visual Studio Marketplace');
  const openVsx = findStep(publish, 'Publish to Open VSX');
  if (marketplace === undefined || !exactKeys(asRecord(marketplace?.env), ['VSCE_PAT'])
    || asRecord(marketplace.env)?.VSCE_PAT !== '${{ secrets.VSCE_PAT }}'
    || openVsx === undefined || !exactKeys(asRecord(openVsx?.env), ['OVSX_PAT'])
    || asRecord(openVsx.env)?.OVSX_PAT !== '${{ secrets.OVSX_PAT }}'
    || marketplace?.uses !== PUBLISH_ACTION
    || openVsx?.uses !== PUBLISH_ACTION) {
    add(violations, 'secret-boundary', 'registry credentials must be scoped to their individual publish steps');
  }
  const marketplaceWith = asRecord(marketplace?.with);
  const openVsxWith = asRecord(openVsx?.with);
  if (!exactKeys(marketplaceWith, ['extensionFile', 'pat', 'registryUrl', 'skipDuplicate'])
    || marketplaceWith?.extensionFile !== '${{ steps.manifest.outputs.vsix-path }}'
    || marketplaceWith?.pat !== '${{ env.VSCE_PAT }}'
    || marketplaceWith?.registryUrl !== 'https://marketplace.visualstudio.com'
    || marketplaceWith?.skipDuplicate !== true
    || !exactKeys(openVsxWith, ['extensionFile', 'pat', 'registryUrl', 'skipDuplicate'])
    || openVsxWith?.extensionFile !== '${{ steps.manifest.outputs.vsix-path }}'
    || openVsxWith?.pat !== '${{ env.OVSX_PAT }}'
    || openVsxWith?.registryUrl !== 'https://open-vsx.org'
    || openVsxWith?.skipDuplicate !== true) {
    add(violations, 'publish-bytes', 'both registries must use the reviewed publisher with the same downloaded VSIX and registry URL');
  }
  if (publishStepsWithSecrets(publish).some(step => step !== marketplace && step !== openVsx)) {
    add(violations, 'secret-boundary', 'verification and artifact steps must not receive registry credentials');
  }
  const finalizerDownload = hasAction(finalize, CANDIDATE_ACTIONS.download);
  const finalizerDownloadOptions = asRecord(finalizerDownload?.with);
  if (!exactKeys(finalizerDownloadOptions, ['artifact-ids', 'github-token', 'path', 'run-id'])
    || finalizerDownloadOptions?.['artifact-ids'] !== '${{ needs.publish.outputs.artifact-id }}'
    || finalizerDownloadOptions?.['run-id'] !== '${{ inputs.candidate_run_id }}'
    || finalizerDownloadOptions?.path !== 'dist/release-candidate') {
    add(violations, 'finalizer-artifact', 'finalizer must consume the exact dispatched artifact already verified and published');
  }
  const tagVerify = findStep(finalize, 'Verify the exact source tag');
  const tagVerifyRun = tagVerify === undefined ? '' : executableRun(tagVerify);
  if (tagVerify === undefined
    || !isFailClosedShellStep(tagVerify)
    || tagVerify.shell !== 'bash'
    || tagVerifyRun !== FINALIZER_TAG_VERIFY_RUN) {
    add(violations, 'finalizer-boundary', 'finalizer must verify the pre-created tag points at the candidate source SHA');
  }
  const createRelease = findStep(finalize, 'Create the GitHub release if absent');
  const createReleaseRun = createRelease === undefined ? '' : executableRun(createRelease);
  if (createRelease === undefined
    || !isFailClosedShellStep(createRelease)
    || createRelease.shell !== 'bash'
    || createReleaseRun !== FINALIZER_CREATE_RELEASE_RUN) {
    add(violations, 'finalizer-boundary', 'finalizer must attach the same VSIX and candidate manifest to the GitHub release');
  }
  const existingRelease = findStep(finalize, 'Verify an existing GitHub release safely');
  const existingReleaseRun = existingRelease === undefined ? '' : executableRun(existingRelease);
  if (existingRelease === undefined
    || !isFailClosedShellStep(existingRelease)
    || existingRelease.shell !== 'bash'
    || existingReleaseRun !== FINALIZER_EXISTING_RELEASE_RUN) {
    add(violations, 'retry-safety', 'finalizer must safely verify existing assets and repair a partially-created release');
  }
  return violations;
}

export function evaluateReleaseConfigPolicy(source: string): ReleaseWorkflowPolicyViolation[] {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  }
  catch (error) {
    return [{ rule: 'release-config', message: `release config is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }];
  }
  const configViolations = validatePrepareReleaseConfig(value);
  return configViolations.map(message => ({ rule: 'release-config', message }));
}