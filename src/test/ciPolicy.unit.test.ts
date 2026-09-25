import { readFileSync } from 'node:fs';
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
  RELEASE_CANDIDATE_WORKFLOW_PATH,
} from '../tools';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const canonicalSource = readFileSync(resolve(repositoryRoot, CI_WORKFLOW_PATH), 'utf8');
const releaseWorkflowPath = RELEASE_CANDIDATE_WORKFLOW_PATH;
const canonicalReleaseSource = readFileSync(resolve(repositoryRoot, releaseWorkflowPath), 'utf8');
const canonicalCodeownersSource = readFileSync(resolve(repositoryRoot, CODEOWNERS_PATH), 'utf8');
const canonicalDependabotSource = readFileSync(resolve(repositoryRoot, DEPENDABOT_CONFIG_PATH), 'utf8');

function mutateWorkflow(mutator: (workflow: Record<string, unknown>) => void): string {
  const workflow = parse(canonicalSource, { uniqueKeys: true }) as Record<string, unknown>;
  mutator(workflow);
  return stringify(workflow);
}

function jobs(workflow: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return workflow.jobs as Record<string, Record<string, unknown>>;
}

function steps(workflow: Record<string, unknown>, job: string): Record<string, unknown>[] {
  return jobs(workflow)[job].steps as Record<string, unknown>[];
}

function removeRun(workflow: Record<string, unknown>, job: string, needle: string): void {
  jobs(workflow)[job].steps = steps(workflow, job).filter(step => !String(step.run ?? '').includes(needle));
}

function expectRejected(source: string, rule: string): void {
  expect(evaluateCiWorkflowPolicy(source)).toEqual(expect.arrayContaining([expect.objectContaining({ rule })]));
}

function expectRejectedDependabot(source: string, rule: string): void {
  expect(evaluateDependabotConfigPolicy(source)).toEqual(
    expect.arrayContaining([expect.objectContaining({ rule })]),
  );
}

describe('CI workflow policy', () => {
  it('accepts the canonical workflow as a complete contract, not a substring smoke test', () => {
    expect(evaluateCiWorkflowPolicy(canonicalSource)).toEqual([]);
  });

  it.each([
    ['dependency audit', 'pnpm run audit:dependencies'],
    ['signature audit', 'pnpm run audit:signatures'],
    ['strict lint', 'pnpm run lint'],
    ['production typecheck', 'pnpm run typecheck'],
    ['test typecheck', 'tsc -p tsconfig.test.json --noEmit'],
    ['workflow policy', 'pnpm run ci:policy'],
    ['unit coverage', 'pnpm run test:unit:coverage'],
    ['build', 'pnpm run build'],
  ])('fails when the %s quality gate is injected out', (_label, command) => {
    expectRejected(mutateWorkflow(workflow => removeRun(workflow, 'quality', command)), 'quality-gate');
  });

  it('rejects pull_request_target even if a normal PR trigger remains', () => {
    expectRejected(mutateWorkflow((workflow) => {
      (workflow.on as Record<string, unknown>).pull_request_target = {};
    }), 'safe-trigger');
  });

  it('rejects narrowed PR event types and extra push filters', () => {
    expectRejected(mutateWorkflow((workflow) => {
      (workflow.on as Record<string, unknown>).pull_request = { types: ['closed'] };
    }), 'safe-trigger');
    expectRejected(mutateWorkflow((workflow) => {
      const push = (workflow.on as Record<string, unknown>).push as Record<string, unknown>;
      push['paths-ignore'] = ['src/**'];
    }), 'safe-trigger');
  });

  it('rejects any permission wider than read-only repository contents', () => {
    expectRejected(mutateWorkflow((workflow) => {
      (workflow.permissions as Record<string, unknown>)['pull-requests'] = 'write';
    }), 'least-permissions');
  });

  it('rejects a mutable external action reference in any job', () => {
    expectRejected(mutateWorkflow((workflow) => {
      steps(workflow, 'quality')[0].uses = 'actions/checkout@v7';
    }), 'immutable-action');
  });

  it('rejects an unreviewed full action commit even though it is immutable-looking', () => {
    expectRejected(mutateWorkflow((workflow) => {
      steps(workflow, 'quality')[0].uses = `actions/checkout@${'f'.repeat(40)}`;
    }), 'reviewed-action');
  });

  it('rejects job-level permission escalation', () => {
    expectRejected(mutateWorkflow((workflow) => {
      jobs(workflow).quality.permissions = { contents: 'write' };
    }), 'least-permissions');
  });

  it('rejects source-identity overrides and workflow shell defaults', () => {
    expectRejected(mutateWorkflow((workflow) => {
      jobs(workflow).quality.env = { EXPECTED_SHA: '0'.repeat(40) };
    }), 'source-identity');
    expectRejected(mutateWorkflow((workflow) => {
      workflow.defaults = { run: { shell: 'bash -n {0}' } };
    }), 'workflow-defaults');
  });

  it('rejects an unreviewed extra job even when its YAML is otherwise valid', () => {
    expectRejected(mutateWorkflow((workflow) => {
      jobs(workflow).publish_backdoor = { runs_on: 'ubuntu-latest', steps: [] };
    }), 'job-allowlist');
  });

  it('rejects an extra publish step hidden inside an allowed job', () => {
    expectRejected(mutateWorkflow((workflow) => {
      steps(workflow, 'quality').push({ run: 'pnpm exec semantic-release', env: { TOKEN: '${{ secrets.TOKEN }}' } });
    }), 'step-allowlist');
  });

  it.each([
    ['echoed lint', 'pnpm run lint', 'echo pnpm run lint'],
    ['disabled build', 'pnpm run build', 'pnpm run build'],
  ])('rejects %s instead of treating it as an executable gate', (_label, command, replacement) => {
    expectRejected(mutateWorkflow((workflow) => {
      const step = steps(workflow, 'quality').find(candidate => candidate.run === command);
      if (step !== undefined) {
        step.run = replacement;
        if (_label === 'disabled build') {
          step.if = '${{ false }}';
        }
      }
    }), _label === 'disabled build' ? 'failure-safe-step' : 'quality-gate');
  });

  it('rejects an echoed checkout identity assertion', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const assertion = steps(workflow, 'quality').find(step => String(step.run).includes('git rev-parse HEAD'));
      if (assertion !== undefined) {
        assertion.run = 'echo git rev-parse HEAD EXPECTED_SHA';
      }
    }), 'exact-checkout');
  });

  it('rejects shell overrides that turn a required command into syntax-only validation', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const lint = steps(workflow, 'quality').find(step => step.run === 'pnpm run lint');
      if (lint !== undefined) {
        lint.shell = 'bash -n {0}';
      }
    }), 'quality-gate');
  });

  it('rejects execution modifiers on reviewed action and run steps', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const setupNode = steps(workflow, 'quality')
        .find(step => String(step.uses ?? '').startsWith('actions/setup-node@'));
      if (setupNode !== undefined) {
        setupNode.if = '${{ cancelled() }}';
      }
    }), 'step-contract');
    expectRejected(mutateWorkflow((workflow) => {
      const lint = steps(workflow, 'quality').find(step => step.run === 'pnpm run lint');
      if (lint !== undefined) {
        lint['working-directory'] = 'fixtures/pass';
      }
    }), 'step-contract');
    expectRejected(mutateWorkflow((workflow) => {
      const host = steps(workflow, 'extension-host')
        .find(step => String(step.run ?? '').startsWith('xvfb-run'));
      if (host !== undefined) {
        host.shell = 'bash -n {0}';
      }
    }), 'step-contract');
  });

  it('rejects extra setup inputs that override the reviewed Node source', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const setupNode = steps(workflow, 'quality')
        .find(step => String(step.uses ?? '').startsWith('actions/setup-node@'));
      const options = setupNode?.with as Record<string, unknown>;
      options['node-version'] = '22.0.0';
    }), 'step-contract');
  });

  it('rejects pnpm/setup that installs a second Node.js runtime from a version file', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const pnpmSetup = steps(workflow, 'quality')
        .find(step => String(step.uses ?? '').startsWith('pnpm/setup@'));
      delete (pnpmSetup?.with as Record<string, unknown>)['node-version-file'];
    }), 'toolchain');
  });

  it('rejects step-scoped EXPECTED_SHA rebinding', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const checkout = steps(workflow, 'quality')[0];
      checkout.env = { EXPECTED_SHA: '0'.repeat(40) };
    }), 'source-identity');
  });

  it.each(['quality', 'extension-host', 'package', 'packaged-smoke'])(
    'rejects a missing checked-out SHA assertion in %s',
    (job) => {
      expectRejected(mutateWorkflow(workflow => removeRun(workflow, job, 'git rev-parse HEAD')), 'exact-checkout');
    },
  );

  it.each(['quality', 'extension-host', 'package', 'packaged-smoke'])(
    'rejects a non-frozen install in %s',
    (job) => {
      expectRejected(mutateWorkflow((workflow) => {
        const install = steps(workflow, job).find(step => String(step.run ?? '').includes('pnpm install'));
        if (install !== undefined) {
          install.run = 'pnpm install';
        }
      }), 'frozen-install');
    },
  );

  it('rejects an incomplete OS/channel Host matrix', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const strategy = jobs(workflow)['extension-host'].strategy as Record<string, unknown>;
      const matrix = strategy.matrix as Record<string, unknown>;
      matrix.channel = ['stable'];
      matrix.os = ['ubuntu-latest'];
    }), 'host-matrix');
  });

  it('rejects matrix jobs whose runner ignores matrix.os', () => {
    expectRejected(mutateWorkflow((workflow) => {
      jobs(workflow)['extension-host']['runs-on'] = 'ubuntu-latest';
    }), 'job-contract');
    expectRejected(mutateWorkflow((workflow) => {
      jobs(workflow)['packaged-smoke']['runs-on'] = 'ubuntu-latest';
    }), 'job-contract');
  });

  it('rejects Host control flow that can bypass quality or narrow matrix execution', () => {
    expectRejected(mutateWorkflow((workflow) => {
      jobs(workflow)['extension-host'].needs = [];
    }), 'job-contract');
    expectRejected(mutateWorkflow((workflow) => {
      jobs(workflow)['extension-host'].if = '${{ always() }}';
    }), 'job-contract');
    expectRejected(mutateWorkflow((workflow) => {
      const strategy = jobs(workflow)['extension-host'].strategy as Record<string, unknown>;
      strategy['max-parallel'] = 1;
    }), 'job-contract');
  });

  it('rejects duplicate dependencies in package and required aggregation', () => {
    expectRejected(mutateWorkflow((workflow) => {
      (jobs(workflow).package.needs as string[]).push('quality');
    }), 'job-contract');
    expectRejected(mutateWorkflow((workflow) => {
      (jobs(workflow).required.needs as string[]).push('quality');
    }), 'job-contract');
  });

  it('rejects a Host matrix that does not build the extension before compiling tests', () => {
    expectRejected(mutateWorkflow(workflow => removeRun(workflow, 'extension-host', 'pnpm run build')), 'step-allowlist');
  });

  it('rejects matrix include/exclude escape hatches and push branch drift', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const strategy = jobs(workflow)['extension-host'].strategy as Record<string, unknown>;
      (strategy.matrix as Record<string, unknown>).exclude = [{ os: 'windows-latest', channel: 'minimum' }];
    }), 'host-matrix');
    expectRejected(mutateWorkflow((workflow) => {
      const push = (workflow.on as Record<string, unknown>).push as Record<string, unknown>;
      push.branches = ['feature'];
    }), 'safe-trigger');
  });

  it('rejects package execution that can survive a failed upstream gate', () => {
    expectRejected(mutateWorkflow((workflow) => {
      jobs(workflow).package.if = '${{ always() }}';
    }), 'failure-safe-needs');
  });

  it('rejects package verification without the clean tracked-checkout guard', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const packageStep = steps(workflow, 'package').find(step => String(step.run ?? '').includes('check:vsce'));
      if (packageStep !== undefined) {
        packageStep.run = 'pnpm run check:vsce';
      }
    }), 'package-policy');
  });

  it.each([
    ['missing files accepted', 'if-no-files-found', 'warn'],
    ['overwrite enabled', 'overwrite', true],
    ['unbounded retention', 'retention-days', 90],
  ])('rejects an upload with %s', (_label, key, value) => {
    expectRejected(mutateWorkflow((workflow) => {
      const upload = steps(workflow, 'package').find(step => String(step.uses ?? '').startsWith('actions/upload-artifact@'));
      (upload?.with as Record<string, unknown>)[key] = value;
    }), 'immutable-artifact');
  });

  it('rejects downloading evidence by a mutable name instead of exact artifact ID', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const download = steps(workflow, 'packaged-smoke')
        .find(step => String(step.uses ?? '').startsWith('actions/download-artifact@'));
      const options = download?.with as Record<string, unknown>;
      delete options['artifact-ids'];
      options.name = 'verify-evidence';
    }), 'exact-artifact-id');
  });

  it('rejects forged or missing producer artifact outputs', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const outputs = jobs(workflow).package.outputs as Record<string, unknown>;
      outputs['artifact-id'] = '${{ github.run_id }}';
    }), 'artifact-outputs');
  });

  it('rejects a required gate that does not run after a skip/failure', () => {
    expectRejected(mutateWorkflow((workflow) => {
      jobs(workflow).required.if = '${{ success() }}';
    }), 'stable-required-gate');
  });

  it('rejects a required gate that forgets one upstream result', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const result = steps(workflow, 'required')[0];
      const env = result.env as Record<string, unknown>;
      delete env.PACKAGED_SMOKE_RESULT;
    }), 'stable-required-gate');
  });

  it('rejects an echo-only required aggregator with correct-looking variable names', () => {
    expectRejected(mutateWorkflow((workflow) => {
      steps(workflow, 'required')[0].run = 'echo "$QUALITY_RESULT $HOST_RESULT $PACKAGE_RESULT $PACKAGED_SMOKE_RESULT"';
    }), 'stable-required-gate');
  });

  it('rejects required-step and required-job failure suppression', () => {
    expectRejected(mutateWorkflow((workflow) => {
      steps(workflow, 'required')[0].if = '${{ cancelled() }}';
    }), 'stable-required-gate');
    expectRejected(mutateWorkflow((workflow) => {
      jobs(workflow).required['continue-on-error'] = true;
    }), 'failure-safe-job');
    expectRejected(mutateWorkflow((workflow) => {
      const lint = steps(workflow, 'quality').find(step => step.run === 'pnpm run lint');
      if (lint !== undefined) {
        lint['continue-on-error'] = '${{ true }}';
      }
    }), 'failure-safe-step');
  });

  it('rejects an aggregator variable bound to the wrong upstream result', () => {
    expectRejected(mutateWorkflow((workflow) => {
      const env = steps(workflow, 'required')[0].env as Record<string, unknown>;
      env.QUALITY_RESULT = '${{ needs.package.result }}';
    }), 'stable-required-gate');
  });

  it('rejects malformed or duplicate-key YAML before evaluating semantics', () => {
    expectRejected('name: Verify\nname: Forged\njobs: {}\n', 'yaml');
  });
});

describe('immutable workflow action policy', () => {
  const checkoutReference = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';

  it('accepts every reviewed action reference and version comment in the current workflows', () => {
    expect(evaluateWorkflowActionPolicy(canonicalSource)).toEqual([]);
    expect(evaluateWorkflowActionPolicy(canonicalReleaseSource)).toEqual([]);
  });

  it.each(['v6', 'main', 'd23441a', 'D23441A48E516B6C34AEA4FA41551A30E30AF803', 'not-a-sha'])(
    'rejects a mutable or non-full release checkout ref %s',
    (ref) => {
      const mutated = canonicalReleaseSource.replace(
        `${checkoutReference} # v7.0.1`,
        `actions/checkout@${ref} # v7.0.1`,
      );
      expectRejectedAction(mutated, 'immutable-action');
    },
  );

  it('rejects an arbitrary full SHA and locator substitution', () => {
    expectRejectedAction(canonicalReleaseSource.replace(
      checkoutReference,
      `actions/checkout@${'f'.repeat(40)}`,
    ), 'reviewed-action');
    expectRejectedAction(canonicalReleaseSource.replace(
      checkoutReference,
      'attacker/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
    ), 'reviewed-action');
    expectRejectedAction(canonicalReleaseSource.replace(
      checkoutReference,
      'actions/checkout/subpath@d23441a48e516b6c34aea4fa41551a30e30af803',
    ), 'reviewed-action');
  });

  it('requires the exact version comment attached to the uses scalar', () => {
    expectRejectedAction(canonicalReleaseSource.replace(' # v7.0.1', ''), 'action-version-comment');
    expectRejectedAction(canonicalReleaseSource.replace('# v7.0.1', '# v7.0.0'), 'action-version-comment');
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
    expect(evaluateWorkflowActionPolicy(inertSource)).toEqual([]);
  });

  it('does not treat a release topology or permissions change as an action-policy violation', () => {
    const mutated = canonicalReleaseSource
      .replace('contents: read', 'contents: write')
      .replace('      - name: Upload the immutable candidate', '      - name: Extra run-only step\n        run: echo unchanged-action-policy\n\n      - name: Upload the immutable candidate');
    expect(evaluateWorkflowActionPolicy(mutated)).toEqual([]);
  });

  it('fails closed on malformed YAML and executable step shape', () => {
    expectRejectedAction('jobs:\n  test: [unterminated\n', 'yaml');
    expectRejectedAction('jobs:\n  test:\n    steps: forged\n', 'workflow-shape');
    expectRejectedAction('jobs:\n  test:\n    steps:\n      - forged\n', 'workflow-shape');
  });
});

describe('reviewed action update policy', () => {
  const releaseCheckoutV6 = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
  const reviewedCheckoutV7 = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

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

  it('models a reviewed full-SHA update and fails closed before an unknown SHA is enrolled', () => {
    const reviewedUpdate = canonicalReleaseSource.replace(releaseCheckoutV6, reviewedCheckoutV7);
    expect(evaluateWorkflowActionPolicy(reviewedUpdate)).toEqual([]);

    const unknownUpdate = canonicalReleaseSource.replace(
      releaseCheckoutV6,
      `actions/checkout@${'f'.repeat(40)} # v8.0.0`,
    );
    expectRejectedAction(unknownUpdate, 'reviewed-action');
    expectRejectedAction(
      canonicalReleaseSource.replace(releaseCheckoutV6, 'actions/checkout@v7 # v7.0.1'),
      'immutable-action',
    );
    expectRejectedAction(
      canonicalReleaseSource.replace(releaseCheckoutV6, reviewedCheckoutV7.replace('v7.0.1', 'v7.0.0')),
      'action-version-comment',
    );
    expectRejectedAction(
      canonicalReleaseSource.replace(releaseCheckoutV6, reviewedCheckoutV7.replace(' # v7.0.1', '')),
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
`)).toEqual([]);
  });

  it('fails closed on workflow alias exhaustion', () => {
    const aliases = Array.from({ length: 101 }, () => '*job').join(', ');
    const source = `job: &job { runs-on: ubuntu-latest, steps: [] }\njobs: { aliases: [${aliases}] }\n`;
    expect(() => evaluateWorkflowActionPolicy(source)).not.toThrow();
    expectRejectedAction(source, 'yaml');
  });
});

function expectRejectedAction(source: string, rule: string): void {
  expect(evaluateWorkflowActionPolicy(source)).toEqual(expect.arrayContaining([expect.objectContaining({ rule })]));
}