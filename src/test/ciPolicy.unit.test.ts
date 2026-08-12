import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CI_WORKFLOW_PATH, evaluateCiWorkflowPolicy } from '../tools';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const canonicalSource = readFileSync(resolve(repositoryRoot, CI_WORKFLOW_PATH), 'utf8');

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

describe('AUD-14 CI workflow policy', () => {
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