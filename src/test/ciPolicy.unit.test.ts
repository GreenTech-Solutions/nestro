import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  CI_WORKFLOW_PATH,
  CODEOWNERS_PATH,
  DEPENDABOT_CONFIG_PATH,
  evaluateCiWorkflowPolicy,
  evaluateCodeownersPolicy,
  evaluateDependabotConfigPolicy,
  evaluateWorkflowActionPolicy,
  findUnusedReviewedActions,
  loadReviewedActionsRegistry,
  loadReviewedRegistryForPolicy,
  parseReviewedActionsRegistry,
  RELEASE_CANDIDATE_WORKFLOW_PATH,
  REVIEWED_ACTIONS_PATH,
  reviewedActionReference,
} from '../tools';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const canonicalSource = readFileSync(resolve(repositoryRoot, CI_WORKFLOW_PATH), 'utf8');
const releaseWorkflowPath = RELEASE_CANDIDATE_WORKFLOW_PATH;
const canonicalReleaseSource = readFileSync(resolve(repositoryRoot, releaseWorkflowPath), 'utf8');
const canonicalCodeownersSource = readFileSync(resolve(repositoryRoot, CODEOWNERS_PATH), 'utf8');
const canonicalDependabotSource = readFileSync(resolve(repositoryRoot, DEPENDABOT_CONFIG_PATH), 'utf8');
const canonicalRegistrySource = readFileSync(resolve(repositoryRoot, REVIEWED_ACTIONS_PATH), 'utf8');
const registry = loadReviewedActionsRegistry(repositoryRoot);
const checkout = registry.actions['actions/checkout'];
const unreviewedSha = 'f'.repeat(40);

type Mapping = Record<string, unknown>;

function mutateWorkflow(mutator: (workflow: Mapping) => void): string {
  const workflow = parse(canonicalSource, { uniqueKeys: true }) as Mapping;
  mutator(workflow);
  return stringify(workflow);
}

function jobs(workflow: Mapping): Record<string, Mapping> {
  return workflow.jobs as Record<string, Mapping>;
}

function steps(workflow: Mapping, job: string): Mapping[] {
  return jobs(workflow)[job].steps as Mapping[];
}

function stepNamed(workflow: Mapping, job: string, name: string): Mapping {
  const found = steps(workflow, job).find(step => step.name === name);
  if (found === undefined) {
    throw new Error(`${job} has no step named ${name}`);
  }
  return found;
}

function removeStep(workflow: Mapping, job: string, name: string): void {
  jobs(workflow)[job].steps = steps(workflow, job).filter(step => step.name !== name);
}

function expectRejected(source: string, rule: string): void {
  expect(evaluateCiWorkflowPolicy(source, registry)).toEqual(expect.arrayContaining([expect.objectContaining({ rule })]));
}

function expectRejectedDependabot(source: string, rule: string): void {
  expect(evaluateDependabotConfigPolicy(source)).toEqual(
    expect.arrayContaining([expect.objectContaining({ rule })]),
  );
}

const SETUP_JOBS = ['quality', 'extension-host', 'package', 'packaged-smoke'];
const QUALITY_GATES = [
  'Audit dependencies',
  'Audit dependency signatures',
  'Strict lint',
  'Production typecheck',
  'Test typecheck',
  'Validate workflow syntax',
  'Lint CI shell scripts',
  'Workflow policy',
  'Unit coverage',
  'Build',
];

const SEMANTIC_MUTATIONS: ReadonlyArray<readonly [string, (workflow: Mapping) => void, string]> = [
  ['pull_request_target next to a normal PR trigger', (w) => {
    (w.on as Mapping).pull_request_target = {};
  }, 'trigger-contract'],
  ['narrowed PR event types', (w) => {
    (w.on as Mapping).pull_request = { types: ['closed'] };
  }, 'trigger-contract'],
  ['an extra push filter', (w) => {
    ((w.on as Mapping).push as Mapping)['paths-ignore'] = ['src/**'];
  }, 'trigger-contract'],
  ['a different push branch', (w) => {
    ((w.on as Mapping).push as Mapping).branches = ['feature'];
  }, 'trigger-contract'],
  ['a wider workflow permission', (w) => {
    (w.permissions as Mapping)['pull-requests'] = 'write';
  }, 'permissions-contract'],
  ['job-level permission escalation', (w) => {
    jobs(w).quality.permissions = { contents: 'write' };
  }, 'job-contract'],
  ['a job-level EXPECTED_SHA override', (w) => {
    jobs(w).quality.env = { EXPECTED_SHA: '0'.repeat(40) };
  }, 'job-contract'],
  ['a step-level EXPECTED_SHA rebinding', (w) => {
    stepNamed(w, 'quality', 'Checkout exact tested commit').env = { EXPECTED_SHA: '0'.repeat(40) };
  }, 'step-contract'],
  ['a workflow-wide shell default', (w) => {
    w.defaults = { run: { shell: 'bash -n {0}' } };
  }, 'workflow-contract'],
  ['a rebound workflow EXPECTED_SHA', (w) => {
    (w.env as Mapping).EXPECTED_SHA = '0'.repeat(40);
  }, 'env-contract'],
  ['an unreviewed extra job', (w) => {
    jobs(w).publish_backdoor = { 'runs-on': 'ubuntu-latest', steps: [] };
  }, 'job-allowlist'],
  ['an extra publish step hidden inside an allowed job', (w) => {
    steps(w, 'quality').push({ run: 'pnpm exec semantic-release', env: { TOKEN: '${{ secrets.TOKEN }}' } });
  }, 'step-allowlist'],
  ['a mutable external action reference', (w) => {
    stepNamed(w, 'quality', 'Checkout exact tested commit').uses = 'actions/checkout@v7';
  }, 'step-contract'],
  ['an unreviewed full action commit', (w) => {
    stepNamed(w, 'quality', 'Checkout exact tested commit').uses = `actions/checkout@${unreviewedSha}`;
  }, 'step-contract'],
  ['an echoed lint gate', (w) => {
    stepNamed(w, 'quality', 'Strict lint').run = 'echo pnpm run lint';
  }, 'step-contract'],
  ['a disabled build gate', (w) => {
    stepNamed(w, 'quality', 'Build').if = '${{ false }}';
  }, 'step-contract'],
  ['an echoed checkout identity assertion', (w) => {
    stepNamed(w, 'quality', 'Assert checkout identity').run = 'echo git rev-parse HEAD EXPECTED_SHA';
  }, 'step-contract'],
  ['a shell override that turns lint into syntax-only validation', (w) => {
    stepNamed(w, 'quality', 'Strict lint').shell = 'bash -n {0}';
  }, 'step-contract'],
  ['a condition on a reviewed action step', (w) => {
    stepNamed(w, 'quality', 'Setup Node.js').if = '${{ cancelled() }}';
  }, 'step-contract'],
  ['a working directory on a run step', (w) => {
    stepNamed(w, 'quality', 'Strict lint')['working-directory'] = 'fixtures/pass';
  }, 'step-contract'],
  ['a shell override on the Host step', (w) => {
    stepNamed(w, 'extension-host', 'Run Extension Host on Linux').shell = 'bash -n {0}';
  }, 'step-contract'],
  ['an extra setup input that overrides the Node source', (w) => {
    (stepNamed(w, 'quality', 'Setup Node.js').with as Mapping)['node-version'] = '22.0.0';
  }, 'step-contract'],
  ['pnpm/setup installing a second Node.js runtime', (w) => {
    delete (stepNamed(w, 'quality', 'Prepare pnpm').with as Mapping)['node-version-file'];
  }, 'step-contract'],
  ['an incomplete OS/channel Host matrix', (w) => {
    const matrix = (jobs(w)['extension-host'].strategy as Mapping).matrix as Mapping;
    matrix.channel = ['stable'];
    matrix.os = ['ubuntu-latest'];
  }, 'job-contract'],
  ['a Host matrix exclude escape hatch', (w) => {
    ((jobs(w)['extension-host'].strategy as Mapping).matrix as Mapping).exclude = [{ os: 'windows-latest', channel: 'minimum' }];
  }, 'job-contract'],
  ['a Host runner that ignores matrix.os', (w) => {
    jobs(w)['extension-host']['runs-on'] = 'ubuntu-latest';
  }, 'job-contract'],
  ['a packaged-smoke runner that ignores matrix.os', (w) => {
    jobs(w)['packaged-smoke']['runs-on'] = 'ubuntu-latest';
  }, 'job-contract'],
  ['a Host job that bypasses quality', (w) => {
    jobs(w)['extension-host'].needs = [];
  }, 'job-contract'],
  ['a Host job that runs after failures', (w) => {
    jobs(w)['extension-host'].if = '${{ always() }}';
  }, 'job-contract'],
  ['a narrowed Host matrix parallelism', (w) => {
    (jobs(w)['extension-host'].strategy as Mapping)['max-parallel'] = 1;
  }, 'job-contract'],
  ['a duplicate package dependency', (w) => {
    (jobs(w).package.needs as string[]).push('quality');
  }, 'job-contract'],
  ['a duplicate required dependency', (w) => {
    (jobs(w).required.needs as string[]).push('quality');
  }, 'job-contract'],
  ['a package job that survives a failed gate', (w) => {
    jobs(w).package.if = '${{ always() }}';
  }, 'job-contract'],
  ['package verification without the clean checkout guard', (w) => {
    stepNamed(w, 'package', 'Package and verify VSIX').run = 'pnpm run check:vsce';
  }, 'step-contract'],
  ['an upload that accepts missing files', (w) => {
    (stepNamed(w, 'package', 'Upload immutable evidence').with as Mapping)['if-no-files-found'] = 'warn';
  }, 'step-contract'],
  ['an upload with overwrite enabled', (w) => {
    (stepNamed(w, 'package', 'Upload immutable evidence').with as Mapping).overwrite = true;
  }, 'step-contract'],
  ['an upload with unbounded retention', (w) => {
    (stepNamed(w, 'package', 'Upload immutable evidence').with as Mapping)['retention-days'] = 90;
  }, 'step-contract'],
  ['an evidence download by mutable name', (w) => {
    const options = stepNamed(w, 'packaged-smoke', 'Download exact immutable evidence').with as Mapping;
    delete options['artifact-ids'];
    options.name = 'verify-evidence';
  }, 'step-contract'],
  ['a forged producer artifact output', (w) => {
    (jobs(w).package.outputs as Mapping)['artifact-id'] = '${{ github.run_id }}';
  }, 'job-contract'],
  ['a required gate that does not run after a skip', (w) => {
    jobs(w).required.if = '${{ success() }}';
  }, 'job-contract'],
  ['a required gate that forgets one upstream result', (w) => {
    delete (stepNamed(w, 'required', 'Reject failed or skipped gates').env as Mapping).PACKAGED_SMOKE_RESULT;
  }, 'step-contract'],
  ['an echo-only required aggregator', (w) => {
    stepNamed(w, 'required', 'Reject failed or skipped gates').run = 'echo "$QUALITY_RESULT $HOST_RESULT $PACKAGE_RESULT $PACKAGED_SMOKE_RESULT"';
  }, 'step-contract'],
  ['a conditional required step', (w) => {
    stepNamed(w, 'required', 'Reject failed or skipped gates').if = '${{ cancelled() }}';
  }, 'step-contract'],
  ['a required job that ignores failure', (w) => {
    jobs(w).required['continue-on-error'] = true;
  }, 'job-contract'],
  ['a gate step that ignores failure', (w) => {
    stepNamed(w, 'quality', 'Strict lint')['continue-on-error'] = '${{ true }}';
  }, 'step-contract'],
  ['an aggregator variable bound to the wrong upstream result', (w) => {
    (stepNamed(w, 'required', 'Reject failed or skipped gates').env as Mapping).QUALITY_RESULT = '${{ needs.package.result }}';
  }, 'step-contract'],
];

describe('CI workflow policy', () => {
  it('accepts the canonical workflow as a complete contract, not a substring smoke test', () => {
    expect(evaluateCiWorkflowPolicy(canonicalSource, registry)).toEqual([]);
  });

  it.each(SEMANTIC_MUTATIONS)('rejects %s', (_label, mutate, rule) => {
    expectRejected(mutateWorkflow(mutate), rule);
  });

  it.each(QUALITY_GATES)('fails when the %s quality gate is injected out', (name) => {
    expectRejected(mutateWorkflow(workflow => removeStep(workflow, 'quality', name)), 'step-allowlist');
  });

  it.each(SETUP_JOBS)('rejects a missing checked-out SHA assertion in %s', (job) => {
    expectRejected(mutateWorkflow(workflow => removeStep(workflow, job, 'Assert checkout identity')), 'step-allowlist');
  });

  it.each(SETUP_JOBS)('rejects a non-frozen install in %s', (job) => {
    expectRejected(mutateWorkflow((workflow) => {
      stepNamed(workflow, job, 'Install frozen dependencies').run = 'pnpm install';
    }), 'step-contract');
  });

  it('rejects a Host matrix that does not build the extension before compiling tests', () => {
    expectRejected(mutateWorkflow(workflow => removeStep(workflow, 'extension-host', 'Build extension')), 'step-allowlist');
  });

  it('names the differing keys without echoing their values', () => {
    const violations = evaluateCiWorkflowPolicy(mutateWorkflow((workflow) => {
      stepNamed(workflow, 'quality', 'Strict lint').run = 'echo secret-value';
    }), registry);
    expect(violations).toEqual([{
      rule: 'step-contract',
      message: 'quality step 9 (Strict lint) must match the reviewed step; differs in: run',
    }]);
  });

  it('rejects malformed or duplicate-key YAML before evaluating semantics', () => {
    expectRejected('name: Verify\nname: Forged\njobs: {}\n', 'yaml');
  });

  it('rejects YAML anchors and aliases anywhere in the workflow', () => {
    expectRejected(canonicalSource.replace('contents: read', 'contents: &level read'), 'yaml');
    expectRejected(canonicalSource.replace('  CI_ARTIFACT_DIR: dist/ci', '  CI_ARTIFACT_DIR: &dir dist/ci\n  OTHER: *dir'), 'yaml');
  });

  it('rejects a workflow that is not a mapping and jobs that are not mappings', () => {
    expectRejected('- not\n- a mapping\n', 'workflow-shape');
    expectRejected(canonicalSource.replace(/^jobs:[\s\S]*$/mu, 'jobs: forged\n'), 'workflow-shape');
    expectRejected(mutateWorkflow((workflow) => {
      jobs(workflow).required = 'forged' as unknown as Mapping;
    }), 'workflow-shape');
  });
});

describe('CI workflow mutations', () => {
  const canonical = parse(canonicalSource) as Mapping;
  const stepCases = Object.entries(jobs(canonical)).flatMap(([jobId, job]) => (job.steps as Mapping[]).flatMap((step, index) => {
    const label = `${jobId} step ${index + 1} (${String(step.name)})`;
    const cases: Array<readonly [string, (workflow: Mapping) => void]> = [
      [`drops ${label}`, (workflow) => {
        (steps(workflow, jobId)).splice(index, 1);
      }],
      [`swaps ${label} with its neighbour`, (workflow) => {
        const list = steps(workflow, jobId);
        const other = index + 1 < list.length ? index + 1 : index - 1;
        [list[index], list[other]] = [list[other], list[index]];
      }],
      [`disables failure on ${label}`, (workflow) => {
        steps(workflow, jobId)[index]['continue-on-error'] = true;
      }],
    ];
    if (typeof step.run === 'string') {
      cases.push([`alters the run of ${label}`, (workflow) => {
        steps(workflow, jobId)[index].run = `${String(step.run)}\ntrue`;
      }]);
    }
    if (typeof step.uses === 'string') {
      cases.push([`repins the action of ${label}`, (workflow) => {
        steps(workflow, jobId)[index].uses = `${String(step.uses).slice(0, String(step.uses).indexOf('@'))}@${unreviewedSha}`;
      }]);
    }
    return cases;
  }));
  const jobCases = Object.entries(jobs(canonical)).flatMap(([jobId, job]) => [
    ...Object.keys(job).filter(key => key !== 'steps').map((key): readonly [string, (workflow: Mapping) => void] => [
      `removes ${key} from ${jobId}`,
      (workflow) => {
        Reflect.deleteProperty(jobs(workflow)[jobId], key);
      },
    ]),
    [`adds a timeout to ${jobId}`, (workflow: Mapping) => {
      jobs(workflow)[jobId]['timeout-minutes'] = 1;
    }] as const,
  ]);
  const headerCases = ['name', 'on', 'permissions', 'env'].map((key): readonly [string, (workflow: Mapping) => void] => [
    `removes the workflow ${key}`,
    (workflow) => {
      Reflect.deleteProperty(workflow, key);
    },
  ]);

  it.each([...stepCases, ...jobCases, ...headerCases])('rejects a workflow that %s', (_label, mutate) => {
    expect(evaluateCiWorkflowPolicy(mutateWorkflow(mutate), registry)).not.toEqual([]);
  });
});

describe('CI workflow shell scripts', () => {
  const scriptRuns = [
    ['Validate workflow syntax', 'quality', 'install-actionlint.sh'],
    ['Lint CI shell scripts', 'quality', 'shellcheck.sh'],
    ['Resolve the exact VSIX attestation subject', 'package', 'resolve-vsix-subject.sh'],
  ] as const;

  function scriptSource(name: string): string {
    return readFileSync(resolve(repositoryRoot, '.github/scripts/ci', name), 'utf8');
  }

  it('keeps every run block at five lines or fewer, except the pre-checkout dispatch check', () => {
    const workflow = parse(canonicalSource) as Mapping;
    for (const jobId of Object.keys(jobs(workflow))) {
      for (const step of steps(workflow, jobId)) {
        if (typeof step.run === 'string' && step.name !== 'Resolve the dispatched pull request') {
          expect(step.run.trim().split('\n').length, `${jobId}: ${String(step.name)}`).toBeLessThanOrEqual(5);
        }
      }
    }
  });

  it.each(scriptRuns)('runs %s as a one-line call to a script in .github/scripts/ci', (name, job, script) => {
    const workflow = parse(canonicalSource) as Mapping;
    expect(stepNamed(workflow, job, name).run).toBe(`bash .github/scripts/ci/${script}`);
    expect(existsSync(resolve(repositoryRoot, '.github/scripts/ci', script))).toBe(true);
  });

  it.each(scriptRuns)('keeps %s strict and free of workflow expressions', (_name, _job, script) => {
    const source = scriptSource(script);
    expect(source.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(source).toMatch(/^set -euo pipefail$/mu);
    expect(source).not.toContain('${{');
  });

  it('takes the actionlint pin from the registry only', () => {
    const script = scriptSource('install-actionlint.sh');
    expect(script).toContain('.github/reviewed-actions.json');
    for (const literal of [registry.actionlint.version, registry.actionlint.sha256]) {
      expect(script).not.toContain(literal);
      expect(canonicalSource).not.toContain(literal);
    }
  });

  it('lints every script under .github/scripts and fails when there is none', () => {
    const script = scriptSource('shellcheck.sh');
    expect(script).toContain('find .github/scripts -type f -name \'*.sh\' -exec shellcheck {} +');
    expect(script).toContain('test -n "$(find .github/scripts -type f -name \'*.sh\' -print -quit)"');
  });

  it.each(scriptRuns)('rejects %s once its script call is inlined or replaced', (name, job) => {
    expectRejected(mutateWorkflow((workflow) => {
      stepNamed(workflow, job, name).run = 'echo skipped';
    }), 'step-contract');
  });

  it('rejects a script call that no longer goes through the reviewed script', () => {
    expectRejected(mutateWorkflow((workflow) => {
      stepNamed(workflow, 'quality', 'Validate workflow syntax').run = 'bash .github/scripts/ci/other.sh';
    }), 'step-contract');
  });

  it('keeps the dispatch resolution inline and ahead of the checkout', () => {
    const workflow = parse(canonicalSource) as Mapping;
    const [first] = steps(workflow, 'quality');
    expect(first.name).toBe('Resolve the dispatched pull request');
    expect(String(first.run)).not.toContain('.github/scripts');
  });

  it('rejects the dispatch resolution once it runs after the checkout', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const [dispatch, ...rest] = steps(workflow, 'quality');
      jobs(workflow).quality.steps = [rest[0], dispatch, ...rest.slice(1)];
    }), 'step-contract');
  });
});

describe('immutable workflow action policy', () => {
  const checkoutReference = reviewedActionReference('actions/checkout');

  it('accepts every reviewed action reference and version comment in the current workflows', () => {
    expect(evaluateWorkflowActionPolicy(canonicalSource, registry)).toEqual([]);
    expect(evaluateWorkflowActionPolicy(canonicalReleaseSource, registry)).toEqual([]);
  });

  it.each(['v6', 'main', checkout.sha.slice(0, 7), checkout.sha.toUpperCase(), 'not-a-sha'])(
    'rejects a mutable or non-full release checkout ref %s',
    (ref) => {
      const mutated = canonicalReleaseSource.replace(
        `${checkoutReference} # ${checkout.tag}`,
        `actions/checkout@${ref} # ${checkout.tag}`,
      );
      expectRejectedAction(mutated, 'immutable-action');
    },
  );

  it('rejects an arbitrary full SHA and locator substitution', () => {
    expectRejectedAction(canonicalReleaseSource.replace(
      checkoutReference,
      `actions/checkout@${unreviewedSha}`,
    ), 'reviewed-action');
    expectRejectedAction(canonicalReleaseSource.replace(
      checkoutReference,
      `attacker/checkout@${checkout.sha}`,
    ), 'reviewed-action');
    expectRejectedAction(canonicalReleaseSource.replace(
      checkoutReference,
      `actions/checkout/subpath@${checkout.sha}`,
    ), 'reviewed-action');
  });

  it('requires the exact version comment attached to the uses scalar', () => {
    expectRejectedAction(canonicalReleaseSource.replace(` # ${checkout.tag}`, ''), 'action-version-comment');
    expectRejectedAction(canonicalReleaseSource.replace(`# ${checkout.tag}`, '# v0.0.0'), 'action-version-comment');
  });

  it.each([
    ['job-level tag', 'jobs:\n  call:\n    uses: owner/repo/.github/workflows/build.yml@v1\n'],
    ['dynamic expression', 'jobs:\n  call:\n    uses: "${{ github.repository }}/.github/workflows/build.yml@main"\n'],
  ])('rejects an unreviewed %s executable reference', (_label, source) => {
    expectRejectedAction(source, 'immutable-action');
  });

  it('rejects local and Docker action forms until their exact code identity is reviewed', () => {
    expectRejectedAction('jobs:\n  call:\n    uses: ./../outside/workflow.yml\n', 'reviewed-local-action');
    expectRejectedAction(
      'jobs:\n  test:\n    steps:\n      - uses: docker://alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      'reviewed-docker-action',
    );
  });

  it('scans only executable job and step uses fields', () => {
    const inertSource = `jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe
        with:
          uses: attacker/action@v1
`;
    expect(evaluateWorkflowActionPolicy(inertSource, registry)).toEqual([]);
  });

  it('does not treat a release topology or permissions change as an action-policy violation', () => {
    const mutated = canonicalReleaseSource
      .replace('contents: read', 'contents: write')
      .replace('      - name: Upload the immutable candidate', '      - name: Extra run-only step\n        run: echo unchanged-action-policy\n\n      - name: Upload the immutable candidate');
    expect(evaluateWorkflowActionPolicy(mutated, registry)).toEqual([]);
  });

  it('fails closed on malformed YAML and executable step shape', () => {
    expectRejectedAction('jobs:\n  test: [unterminated\n', 'yaml');
    expectRejectedAction('jobs:\n  test:\n    steps: forged\n', 'workflow-shape');
    expectRejectedAction('jobs:\n  test:\n    steps:\n      - forged\n', 'workflow-shape');
  });
});

describe('reviewed action update policy', () => {
  const reviewedCheckout = `${reviewedActionReference('actions/checkout')} # ${checkout.tag}`;

  it('accepts only the canonical standalone GitHub Actions updater and .github owner', () => {
    expect(evaluateDependabotConfigPolicy(canonicalDependabotSource)).toEqual([]);
    expect(evaluateCodeownersPolicy(canonicalCodeownersSource)).toEqual([]);
  });

  it.each([
    ['another ecosystem', 'github-actions', 'npm'],
    ['another directory', 'directory: /', 'directory: /packages'],
    ['daily updates', 'interval: weekly', 'interval: daily'],
    ['another weekday', 'day: monday', 'day: friday'],
    ['another time', 'time: "04:00"', 'time: "12:00"'],
    ['another timezone', 'timezone: UTC', 'timezone: Asia/Bangkok'],
    ['a wider PR limit', 'open-pull-requests-limit: 2', 'open-pull-requests-limit: 5'],
    ['another commit prefix', 'prefix: ci(deps)', 'prefix: chore(deps)'],
  ])('rejects %s in the updater contract', (_label, current, replacement) => {
    expectRejectedDependabot(canonicalDependabotSource.replace(current, replacement), 'dependabot-contract');
  });

  it.each([
    ['groups', '    groups:\n      actions:\n        patterns: ["*"]\n'],
    ['custom labels', '    labels: [dependencies]\n'],
    ['retired reviewers', '    reviewers: [GreenTech-Solutions]\n'],
    ['target branch', '    target-branch: release\n'],
    ['automatic assignment', '    assignees: [GreenTech-Solutions]\n'],
  ])('rejects an extra %s option', (_label, option) => {
    expectRejectedDependabot(`${canonicalDependabotSource}${option}`, 'dependabot-contract');
  });

  it('rejects a second updater, duplicate keys, malformed YAML and aliases without throwing', () => {
    const secondUpdater = canonicalDependabotSource.replace(
      'updates:\n',
      `updates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n`,
    );
    expectRejectedDependabot(secondUpdater, 'dependabot-contract');
    expectRejectedDependabot(`${canonicalDependabotSource}version: 2\n`, 'dependabot-yaml');
    expectRejectedDependabot('version: 2\nupdates: [unterminated\n', 'dependabot-yaml');
    expectRejectedDependabot('version: 2\nupdates: &updates [*updates]\n', 'dependabot-yaml');
    expectRejectedDependabot(canonicalDependabotSource.replace('schedule:', 'schedule: &schedule'), 'dependabot-yaml');

    const aliases = Array.from({ length: 101 }, () => '*updater').join(', ');
    expect(() => evaluateDependabotConfigPolicy(
      `version: 2\nupdater: &updater { package-ecosystem: github-actions }\nupdates: [${aliases}]\n`,
    )).not.toThrow();
    expectRejectedDependabot(
      `version: 2\nupdater: &updater { package-ecosystem: github-actions }\nupdates: [${aliases}]\n`,
      'dependabot-yaml',
    );
  });

  it.each([
    ['a narrower path', '/.github/workflows/ @GreenTech-Solutions\n'],
    ['another owner', '/.github/ @attacker\n'],
    ['a later override', '/.github/ @GreenTech-Solutions\n/.github/workflows/ @attacker\n'],
    ['an extra comment', '# privileged files\n/.github/ @GreenTech-Solutions\n'],
    ['a missing final newline', '/.github/ @GreenTech-Solutions'],
  ])('rejects CODEOWNERS with %s', (_label, source) => {
    expect(evaluateCodeownersPolicy(source)).toEqual([
      expect.objectContaining({ rule: 'codeowners-contract' }),
    ]);
  });

  it('accepts the registry pin and fails closed on an unenrolled SHA, mutable tag and bad version comment', () => {
    expect(evaluateWorkflowActionPolicy(canonicalReleaseSource, registry)).toEqual([]);

    const unknownUpdate = canonicalReleaseSource.replace(
      reviewedCheckout,
      `actions/checkout@${unreviewedSha} # v8.0.0`,
    );
    expectRejectedAction(unknownUpdate, 'reviewed-action');
    expectRejectedAction(
      canonicalReleaseSource.replace(reviewedCheckout, `actions/checkout@v7 # ${checkout.tag}`),
      'immutable-action',
    );
    expectRejectedAction(
      canonicalReleaseSource.replace(reviewedCheckout, reviewedCheckout.replace(checkout.tag, 'v0.0.0')),
      'action-version-comment',
    );
    expectRejectedAction(
      canonicalReleaseSource.replace(reviewedCheckout, reviewedCheckout.replace(` # ${checkout.tag}`, '')),
      'action-version-comment',
    );
  });

  it.each([
    ['GitHub CLI merge', 'gh pr merge 42 --auto'],
    ['GraphQL auto-merge mutation', 'gh api graphql -f query="mutation { enablePullRequestAutoMerge(input: {}) }"'],
    ['REST merge endpoint', 'gh api --method PUT repos/acme/repo/pulls/42/merge'],
  ])('rejects a direct %s command', (_label, command) => {
    expectRejectedAction(`jobs:\n  merge:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${JSON.stringify(command)}\n`, 'dependabot-auto-merge');
  });

  it('rejects direct auto-merge actions and reusable workflows while ignoring inert text', () => {
    expectRejectedAction(
      `jobs:\n  merge:\n    uses: owner/auto-merge@${'a'.repeat(40)} # v1\n`,
      'dependabot-auto-merge',
    );
    expectRejectedAction(
      `jobs:\n  merge:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: owner/auto-merge@${'a'.repeat(40)} # v1\n`,
      'dependabot-auto-merge',
    );
    expect(evaluateWorkflowActionPolicy(`jobs:
  safe:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe
        env:
          NOTE: gh pr merge --auto
`, registry)).toEqual([]);
  });

  it('fails closed on workflow alias exhaustion', () => {
    const aliases = Array.from({ length: 101 }, () => '*job').join(', ');
    const source = `job: &job { runs-on: ubuntu-latest, steps: [] }\njobs: { aliases: [${aliases}] }\n`;
    expect(() => evaluateWorkflowActionPolicy(source, registry)).not.toThrow();
    expectRejectedAction(source, 'yaml');
  });
});

function expectRejectedAction(source: string, rule: string): void {
  expect(evaluateWorkflowActionPolicy(source, registry)).toEqual(expect.arrayContaining([expect.objectContaining({ rule })]));
}

describe('reviewed actions registry', () => {
  interface RegistryDraft {
    [key: string]: unknown;
    actionlint: Record<string, unknown>;
    actions: Record<string, Record<string, unknown>>;
  }

  function registryWith(mutator: (draft: RegistryDraft) => void): string {
    const draft = JSON.parse(canonicalRegistrySource) as RegistryDraft;
    mutator(draft);
    return JSON.stringify(draft);
  }

  it('loads the canonical registry with every pin in the workflows', () => {
    expect(parseReviewedActionsRegistry(canonicalRegistrySource)).toEqual(registry);
    expect(Object.keys(registry.actions)).toEqual(expect.arrayContaining([
      'actions/checkout',
      'actions/download-artifact',
      'actions/setup-node',
      'actions/upload-artifact',
      'pnpm/setup',
      'actions/attest-build-provenance',
      'HaaLeo/publish-vscode-extension',
    ]));
  });

  it('builds action references from registry entries and rejects unknown actions', () => {
    expect(reviewedActionReference('actions/checkout')).toBe(`actions/checkout@${checkout.sha}`);
    expect(() => reviewedActionReference('attacker/checkout')).toThrow('not a reviewed action');
    expect(() => reviewedActionReference('toString')).toThrow('not a reviewed action');
  });

  it.each([
    ['malformed JSON', '{ "actions": '],
    ['a non-object root', '[]'],
    ['a missing actionlint entry', registryWith((value) => {
      Reflect.deleteProperty(value, 'actionlint');
    })],
    ['an unknown top-level key', registryWith((value) => {
      value.extra = {};
    })],
    ['a short actionlint digest', registryWith((value) => {
      value.actionlint.sha256 = 'a'.repeat(63);
    })],
    ['an uppercase actionlint digest', registryWith((value) => {
      value.actionlint.sha256 = 'A'.repeat(64);
    })],
    ['a non-numeric actionlint version', registryWith((value) => {
      value.actionlint.version = 'latest';
    })],
    ['an extra actionlint key', registryWith((value) => {
      value.actionlint.url = 'https://example.invalid';
    })],
    ['an empty actions mapping', registryWith((value) => {
      value.actions = {};
    })],
    ['an array of actions', registryWith((value) => {
      value.actions = [] as unknown as RegistryDraft['actions'];
    })],
    ['a key without an owner', registryWith((value) => {
      value.actions.checkout = value.actions['actions/checkout'];
    })],
    ['a key with a ref', registryWith((value) => {
      value.actions['actions/checkout@v7'] = value.actions['actions/checkout'];
    })],
    ['a short SHA', registryWith((value) => {
      value.actions['actions/checkout'].sha = checkout.sha.slice(0, 7);
    })],
    ['an uppercase SHA', registryWith((value) => {
      value.actions['actions/checkout'].sha = checkout.sha.toUpperCase();
    })],
    ['a non-semver tag', registryWith((value) => {
      value.actions['actions/checkout'].tag = 'v7';
    })],
    ['an extra entry key', registryWith((value) => {
      value.actions['actions/checkout'].note = 'x';
    })],
    ['a non-object entry', registryWith((value) => {
      value.actions['actions/checkout'] = checkout.sha as unknown as Record<string, unknown>;
    })],
  ])('rejects a registry with %s', (_label, source) => {
    expect(() => parseReviewedActionsRegistry(source)).toThrow(REVIEWED_ACTIONS_PATH);
  });

  it('fails closed when the registry file is missing from the repository root', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'nestro-registry-'));
    try {
      expect(() => loadReviewedActionsRegistry(root)).toThrow();
    }
    finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('rejects a workflow pinned to a SHA the registry no longer lists', () => {
    const stale = canonicalReleaseSource.replace(reviewedActionReference('actions/checkout'), `actions/checkout@${unreviewedSha}`);
    expectRejectedAction(stale, 'reviewed-action');
  });

  it('loads the canonical registry for policy use without violations', () => {
    expect(loadReviewedRegistryForPolicy(canonicalRegistrySource)).toEqual({ registry, violations: [] });
  });

  it.each([
    ['malformed JSON', '{ "actions": '],
    ['an unknown top-level key', registryWith((value) => {
      value.extra = {};
    })],
    ['a short SHA', registryWith((value) => {
      value.actions['actions/checkout'].sha = checkout.sha.slice(0, 7);
    })],
  ])('reports %s as a violation instead of throwing', (_label, source) => {
    const loaded = loadReviewedRegistryForPolicy(source);
    expect(loaded.registry).toBeUndefined();
    expect(loaded.violations).toEqual([{ rule: 'reviewed-registry', message: expect.not.stringContaining(REVIEWED_ACTIONS_PATH) as string }]);
  });
});

describe('reviewed registry usage', () => {
  const workflowsDirectory = resolve(repositoryRoot, '.github/workflows');
  const workflowSources = readdirSync(workflowsDirectory)
    .filter(name => /\.ya?ml$/u.test(name))
    .map(name => readFileSync(resolve(workflowsDirectory, name), 'utf8'));
  const withExtraEntry = {
    ...registry,
    actions: { ...registry.actions, 'owner/unused': { sha: unreviewedSha, tag: 'v1.0.0' } },
  };

  it('finds every canonical registry entry in some workflow', () => {
    expect(findUnusedReviewedActions(registry, workflowSources)).toEqual([]);
  });

  it('reports an entry that no workflow uses', () => {
    expect(findUnusedReviewedActions(withExtraEntry, workflowSources)).toEqual([
      { rule: 'unused-registry-entry', message: 'owner/unused is in the reviewed registry but no workflow uses it' },
    ]);
  });

  it('reports every entry once the workflows stop using them', () => {
    expect(findUnusedReviewedActions(registry, [])).toHaveLength(Object.keys(registry.actions).length);
  });

  it('counts job-level uses and skips workflows it cannot parse', () => {
    const jobLevel = `jobs:\n  call:\n    uses: owner/unused@${unreviewedSha}\n`;
    expect(findUnusedReviewedActions(withExtraEntry, [...workflowSources, jobLevel, 'jobs: [unterminated\n'])).toEqual([]);
  });
});