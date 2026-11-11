import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  buildReleaseCandidate,
  evaluateCiWorkflowPolicy,
  evaluateReleaseCandidateWorkflowPolicy,
  evaluateReleaseConfigPolicy,
  evaluateReleaseDispatchWorkflowPolicy,
  evaluateReleasePrepareWorkflowPolicy,
  evaluateReleaseWorkflowPolicy,
  parseReviewedActionsRegistry,
  RELEASE_CONTRACT,
  REVIEWED_ACTIONS_PATH,
} from '../tools';
import type { ReleaseCandidateEvidence, ReviewedActionsRegistry, WorkflowViolation } from '../tools';

type Workflow = Record<string, unknown>;
type Mapping = Record<string, unknown>;

const repositoryRoot = resolve(import.meta.dirname, '../..');
const registry = parseReviewedActionsRegistry(readFileSync(resolve(repositoryRoot, REVIEWED_ACTIONS_PATH), 'utf8'));
const readWorkflow = (name: string): string => readFileSync(resolve(repositoryRoot, '.github/workflows', name), 'utf8');
const prepareSource = readWorkflow('release-prepare.yml');
const candidateSource = readWorkflow('release-candidate.yml');
const dispatchSource = readWorkflow('release-dispatch.yml');
const releaseSource = readWorkflow('release.yml');
const releaseConfigSource = readFileSync(resolve(repositoryRoot, '.releaserc.json'), 'utf8');
const staleSha = 'e'.repeat(40);

const evaluatePrepare = (source: string): WorkflowViolation[] => evaluateReleasePrepareWorkflowPolicy(source, registry);
const evaluateCandidate = (source: string): WorkflowViolation[] => evaluateReleaseCandidateWorkflowPolicy(source, registry);
const evaluateDispatch = (source: string): WorkflowViolation[] => evaluateReleaseDispatchWorkflowPolicy(source, registry);
const evaluateRelease = (source: string): WorkflowViolation[] => evaluateReleaseWorkflowPolicy(source, registry);

function scriptSource(name: string): string {
  return readFileSync(resolve(repositoryRoot, '.github/scripts/release', name), 'utf8');
}

function mutate(source: string, mutator: (workflow: Workflow) => void): string {
  const workflow = parse(source, { uniqueKeys: true }) as Workflow;
  mutator(workflow);
  return stringify(workflow);
}

function jobs(workflow: Workflow): Record<string, Mapping> {
  return workflow.jobs as Record<string, Mapping>;
}

function steps(workflow: Workflow, job: string): Mapping[] {
  return jobs(workflow)[job].steps as Mapping[];
}

function stepNamed(workflow: Workflow, job: string, name: string): Mapping {
  const found = steps(workflow, job).find(step => step.name === name);
  if (found === undefined) {
    throw new Error(`${job} has no step named ${name}`);
  }
  return found;
}

function removeStep(workflow: Workflow, job: string, name: string): void {
  jobs(workflow)[job].steps = steps(workflow, job).filter(step => step.name !== name);
}

function mapping(value: unknown): Mapping {
  return value as Mapping;
}

function expectViolation(violations: readonly { readonly rule: string }[], rule: string): void {
  expect(violations).toEqual(expect.arrayContaining([expect.objectContaining({ rule })]));
}

const ECHO_ONLY_RUN = 'echo actions/runs/ .head_sha master push success';
const SCRIPT_CHECKOUT = 'Check out the reviewed scripts';

const WORKFLOWS = [
  ['release-prepare.yml', prepareSource, evaluatePrepare],
  ['release-candidate.yml', candidateSource, evaluateCandidate],
  ['release-dispatch.yml', dispatchSource, evaluateDispatch],
  ['release.yml', releaseSource, evaluateRelease],
] as const;

describe('release workflow policies', () => {
  it('accepts the reviewed preparation, candidate, dispatch, publish/finalizer and config contracts', () => {
    expect(evaluatePrepare(prepareSource)).toEqual([]);
    expect(evaluateCandidate(candidateSource)).toEqual([]);
    expect(evaluateDispatch(dispatchSource)).toEqual([]);
    expect(evaluateRelease(releaseSource)).toEqual([]);
    expect(evaluateReleaseConfigPolicy(releaseConfigSource)).toEqual([]);
  });

  it.each(WORKFLOWS)('rejects an echo that merely mentions the run-identity words in place of a step of %s', (_name, source, evaluate) => {
    const workflow = parse(source) as Workflow;
    for (const [jobId, job] of Object.entries(jobs(workflow))) {
      for (const step of job.steps as Mapping[]) {
        if (typeof step.run === 'string') {
          const violations = evaluate(mutate(source, (mutated) => {
            stepNamed(mutated, jobId, String(step.name)).run = ECHO_ONLY_RUN;
          }));
          expectViolation(violations, 'step-contract');
        }
      }
    }
  });

  it('rejects a run-identity check that only names the run, in preparation and candidate jobs', () => {
    for (const [source, evaluate, job] of [[prepareSource, evaluatePrepare, 'prepare'], [candidateSource, evaluateCandidate, 'candidate']] as const) {
      expectViolation(evaluate(mutate(source, (workflow) => {
        stepNamed(workflow, job, 'Verify the completed verification run').run = 'gh api actions/runs/42';
      })), 'step-contract');
    }
  });

  it.each(WORKFLOWS)('pins every field of every step of %s', (_name, source, evaluate) => {
    const workflow = parse(source) as Workflow;
    for (const [jobId, job] of Object.entries(jobs(workflow))) {
      for (const [index, step] of (job.steps as Mapping[]).entries()) {
        const mutations: [string, (mutated: Workflow) => void][] = [
          ['removal', (mutated) => { steps(mutated, jobId).splice(index, 1); }],
          ['continue-on-error', (mutated) => { steps(mutated, jobId)[index]['continue-on-error'] = true; }],
          ['an extra variable', (mutated) => { steps(mutated, jobId)[index].env = { ...mapping(steps(mutated, jobId)[index].env), EXTRA: 'x' }; }],
          ['a swap with the next step', (mutated) => {
            const list = steps(mutated, jobId);
            [list[index], list[(index + 1) % list.length]] = [list[(index + 1) % list.length], list[index]];
          }],
          ...Object.keys(step).map((key): [string, (mutated: Workflow) => void] => [`deleting ${key}`, (mutated) => { delete steps(mutated, jobId)[index][key]; }]),
          ...Object.keys(step).map((key): [string, (mutated: Workflow) => void] => [`rewriting ${key}`, (mutated) => { steps(mutated, jobId)[index][key] = 'forged'; }]),
        ];
        for (const [label, mutation] of mutations) {
          expect(evaluate(mutate(source, mutation)), `${jobId} step ${index + 1}: ${label}`).not.toEqual([]);
        }
      }
    }
  });

  it.each(WORKFLOWS)('pins every header key and job control of %s', (_name, source, evaluate) => {
    const workflow = parse(source) as Workflow;
    for (const key of Object.keys(workflow).filter(name => name !== 'jobs')) {
      expect(evaluate(mutate(source, (mutated) => { delete mutated[key]; })), `deleting ${key}`).not.toEqual([]);
    }
    expectViolation(evaluate(mutate(source, (mutated) => { mutated.defaults = { run: { shell: 'bash -n {0}' } }; })), 'workflow-contract');
    for (const [jobId, job] of Object.entries(jobs(workflow))) {
      for (const key of Object.keys(job).filter(name => name !== 'steps')) {
        expectViolation(evaluate(mutate(source, (mutated) => { delete jobs(mutated)[jobId][key]; })), 'job-contract');
      }
      expectViolation(evaluate(mutate(source, (mutated) => { jobs(mutated)[jobId]['timeout-minutes'] = 1; })), 'job-contract');
      expectViolation(evaluate(mutate(source, (mutated) => { jobs(mutated)[jobId]['continue-on-error'] = true; })), 'job-contract');
    }
    expectViolation(evaluate(mutate(source, (mutated) => { jobs(mutated).extra = { 'runs-on': 'ubuntu-latest', steps: [] }; })), 'job-allowlist');
  });

  it('rejects an action locator that is not in the reviewed registry', () => {
    const withoutPnpm: ReviewedActionsRegistry = {
      ...registry,
      actions: Object.fromEntries(Object.entries(registry.actions).filter(([locator]) => locator !== 'pnpm/setup')),
    };
    expectViolation(evaluateReleasePrepareWorkflowPolicy(prepareSource, withoutPnpm), 'reviewed-action');
  });

  it('rejects implicit triggers and privilege changes in preparation', () => {
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      (workflow.on as Mapping).push = { branches: ['master'] };
    })), 'trigger-contract');
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      (workflow.permissions as Mapping).issues = 'write';
    })), 'permissions-contract');
    const withSecret = evaluatePrepare(mutate(prepareSource, (workflow) => {
      (jobs(workflow).prepare.env as Mapping).VSCE_PAT = '${{ secrets.VSCE_PAT }}';
    }));
    expectViolation(withSecret, 'secret-boundary');
    expectViolation(withSecret, 'job-contract');
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      steps(workflow, 'prepare').push({ name: 'Unexpected side effect', run: 'gh api --method DELETE' });
    })), 'step-allowlist');
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      (workflow.env as Mapping).SOURCE_SHA = 'master';
    })), 'env-contract');
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      workflow.concurrency = { 'cancel-in-progress': true, group: 'release-prepare' };
    })), 'workflow-contract');
  });

  it('rejects stale master, duplicate version pull requests and forged dispatch identity', () => {
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      removeStep(workflow, 'prepare', 'Assert checkout identity');
    })), 'step-allowlist');
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      removeStep(workflow, 'prepare', 'Reject a stale master');
    })), 'step-allowlist');
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      removeStep(workflow, 'prepare', 'Reject competing release pull requests');
    })), 'step-allowlist');
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      const competing = stepNamed(workflow, 'prepare', 'Reject competing release pull requests');
      competing.run = String(competing.run).replace('$(jq -r \'.parents[0].sha\' <<<"$commit")', 'forged-parent');
    })), 'step-contract');
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      stepNamed(workflow, 'prepare', 'Dispatch exact-head verification for the version pull request').run = 'gh workflow run ci.yml --ref "$PR_BRANCH" -f "pr_number=$OTHER"';
    })), 'step-contract');
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      const resolvePullRequest = stepNamed(workflow, 'prepare', 'Resolve the exact version pull request');
      resolvePullRequest.run = String(resolvePullRequest.run).replace('test "$head_sha" = "$EXISTING_HEAD_SHA"', 'test -n "$head_sha"');
    })), 'step-contract');
  });

  it('rejects an analyze step that overrides the release configuration path', () => {
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      stepNamed(workflow, 'prepare', 'Analyze and prepare the next release').env = { RELEASE_CONFIG: 'other.json' };
    })), 'step-contract');
  });

  it('rejects candidate artifacts that are not frozen to the exact run', () => {
    expectViolation(evaluateCandidate(mutate(candidateSource, (workflow) => {
      mapping(stepNamed(workflow, 'candidate', 'Download the exact verified evidence').with)['run-id'] = '42';
    })), 'step-contract');
    expectViolation(evaluateCandidate(mutate(candidateSource, (workflow) => {
      mapping(stepNamed(workflow, 'candidate', 'Checkout the exact versioned commit').with).ref = 'master';
    })), 'step-contract');
    expectViolation(evaluateCandidate(mutate(candidateSource, (workflow) => {
      stepNamed(workflow, 'candidate', 'Build the candidate manifest').run = 'pnpm run build';
    })), 'step-contract');
    expectViolation(evaluateCandidate(mutate(candidateSource, (workflow) => {
      (jobs(workflow).candidate.permissions as Mapping).contents = 'write';
    })), 'job-contract');
    expectViolation(evaluateCandidate(mutate(candidateSource, (workflow) => {
      mapping(stepNamed(workflow, 'candidate', 'Upload the immutable candidate').with).overwrite = true;
    })), 'step-contract');
  });

  it('rejects dispatches that substitute the candidate run, artifact, source tag or publish ref', () => {
    expectViolation(evaluateDispatch(mutate(dispatchSource, (workflow) => {
      delete (jobs(workflow).dispatch.env as Mapping).GH_REPO;
    })), 'job-contract');
    expectViolation(evaluateDispatch(mutate(dispatchSource, (workflow) => {
      stepNamed(workflow, 'dispatch', 'Resolve the exact candidate artifact').run = 'artifacts="$(gh api repos/example/actions/runs/42/artifacts)"\ncount=0';
    })), 'step-contract');
    expectViolation(evaluateDispatch(mutate(dispatchSource, (workflow) => {
      stepNamed(workflow, 'dispatch', 'Verify the candidate and source run').run = 'test "$(jq -r \'.head_sha\' <<<"$ci_run")" = forged';
    })), 'step-contract');
    expectViolation(evaluateDispatch(mutate(dispatchSource, (workflow) => {
      stepNamed(workflow, 'dispatch', 'Create or verify the exact source tag').run = 'gh api --method POST repos/example/git/refs -f ref=refs/tags/v0.5.0 -f sha=forged';
    })), 'step-contract');
    expectViolation(evaluateDispatch(mutate(dispatchSource, (workflow) => {
      stepNamed(workflow, 'dispatch', 'Dispatch protected publish on the tag').run = 'gh workflow run release.yml --ref "$OTHER_TAG" -f "candidate_run_id=$OTHER" -f "artifact_id=$OTHER"';
    })), 'step-contract');
    expectViolation(evaluateDispatch(mutate(dispatchSource, (workflow) => {
      mapping(stepNamed(workflow, 'dispatch', 'Download the exact candidate artifact').with)['artifact-ids'] = 'forged';
    })), 'step-contract');
  });

  it('keeps the sidecar digest check relative to the bundle directory in the shared script library', () => {
    expect(scriptSource('candidate-lib.sh')).toContain('(cd "$1" && sha256sum --check --strict "$digest_file")');
  });

  it('rejects source, version, digest and secret boundary substitutions in publish', () => {
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      delete jobs(workflow).publish.environment;
    })), 'job-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      steps(workflow, 'publish').push({ name: 'Checkout source', uses: `actions/checkout@${registry.actions['actions/checkout'].sha}` });
    })), 'step-allowlist');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      stepNamed(workflow, 'publish', 'Verify the candidate manifest, tag and digest').run = 'test -n candidate.json';
    })), 'step-contract');
    const inheritedSecret = evaluateRelease(mutate(releaseSource, (workflow) => {
      jobs(workflow).publish.env = { OVSX_PAT: '${{ secrets.OVSX_PAT }}' };
    }));
    expectViolation(inheritedSecret, 'secret-boundary');
    expectViolation(inheritedSecret, 'job-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      mapping(stepNamed(workflow, 'publish', 'Download the exact candidate artifact').with)['artifact-ids'] = 'forged';
    })), 'step-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      workflow.permissions = { contents: 'write' };
    })), 'permissions-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      workflow.concurrency = { 'cancel-in-progress': true, group: 'release' };
    })), 'workflow-contract');
  });

  it('confines registry credentials to the two publish-action steps', () => {
    const secretOn = (job: string, name: string): string => mutate(releaseSource, (workflow) => {
      stepNamed(workflow, job, name).env = { VSCE_PAT: '${{ secrets.VSCE_PAT }}' };
    });
    expectViolation(evaluateRelease(secretOn('publish', 'Verify protected candidate attestation')), 'secret-boundary');
    expectViolation(evaluateRelease(secretOn('publish', 'Compare post-publish registry copies')), 'secret-boundary');
    expectViolation(evaluateRelease(secretOn('finalize', 'Create the GitHub release if absent')), 'secret-boundary');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      workflow.env = { PAT: '${{ secrets.OVSX_PAT }}' };
    })), 'secret-boundary');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      jobs(workflow).finalize.env = { GH_TOKEN: '${{ secrets.VSCE_PAT }}' };
    })), 'secret-boundary');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      stepNamed(workflow, 'publish', 'Verify protected candidate attestation').with = { inputs: ['${{ secrets.OVSX_PAT }}'] };
    })), 'secret-boundary');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      mapping(stepNamed(workflow, 'finalize', 'Create the GitHub release if absent').env).VSCE_PAT = 'forged';
    })), 'secret-boundary');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      jobs(workflow).publish = 'forged' as unknown as Mapping;
    })), 'workflow-shape');
    for (const [source, evaluate] of [[candidateSource, evaluateCandidate], [dispatchSource, evaluateDispatch]] as const) {
      expectViolation(evaluate(mutate(source, (workflow) => {
        workflow.env = { ...mapping(workflow.env), TOKEN: '${{ secrets.OVSX_PAT }}' };
      })), 'secret-boundary');
    }
  });

  it.each(['dispatch', 'publish', 'finalize'] as const)('requires the %s job to check out only the reviewed scripts and contract at the workflow commit', (job) => {
    const source = job === 'dispatch' ? dispatchSource : releaseSource;
    const evaluate = job === 'dispatch' ? evaluateDispatch : evaluateRelease;
    const withOptions = (workflow: Workflow): Mapping => mapping(stepNamed(workflow, job, SCRIPT_CHECKOUT).with);
    const mutations: ((workflow: Workflow) => void)[] = [
      (workflow) => { delete withOptions(workflow)['persist-credentials']; },
      (workflow) => { withOptions(workflow)['persist-credentials'] = true; },
      (workflow) => { withOptions(workflow).ref = '${{ steps.manifest.outputs.source-sha }}'; },
      (workflow) => { delete withOptions(workflow).ref; },
      (workflow) => { withOptions(workflow)['sparse-checkout'] = '.'; },
      (workflow) => { withOptions(workflow)['sparse-checkout'] = '.github/scripts\n'; },
      (workflow) => { delete withOptions(workflow)['sparse-checkout']; },
      (workflow) => { withOptions(workflow)['sparse-checkout-cone-mode'] = true; },
      (workflow) => { withOptions(workflow).path = '.'; },
      (workflow) => { stepNamed(workflow, job, SCRIPT_CHECKOUT).uses = 'actions/checkout@v7'; },
      (workflow) => { stepNamed(workflow, job, SCRIPT_CHECKOUT).run = 'pnpm install'; },
    ];
    expect(evaluate(source)).toEqual([]);
    for (const mutation of mutations) {
      expectViolation(evaluate(mutate(source, mutation)), 'step-contract');
    }
    expectViolation(evaluate(mutate(source, workflow => removeStep(workflow, job, SCRIPT_CHECKOUT))), 'step-allowlist');
  });

  it.each(['dispatch', 'publish', 'finalize'] as const)('rejects a script checkout that is not the first %s step', (job) => {
    const source = job === 'dispatch' ? dispatchSource : releaseSource;
    const evaluate = job === 'dispatch' ? evaluateDispatch : evaluateRelease;
    expectViolation(evaluate(mutate(source, (workflow) => {
      const jobSteps = steps(workflow, job);
      const [checkout] = jobSteps.splice(0, 1);
      jobSteps.splice(1, 0, checkout);
    })), 'step-contract');
  });

  it('rejects a second checkout, install or build in the publish and finalize jobs', () => {
    for (const job of ['publish', 'finalize']) {
      for (const extra of [
        { name: 'Checkout source', uses: `actions/checkout@${registry.actions['actions/checkout'].sha}` },
        { name: 'Build again', run: 'pnpm run build' },
        { name: 'Install', run: 'pnpm install' },
      ]) {
        expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
          steps(workflow, job).push(extra);
        })), 'step-allowlist');
      }
    }
  });

  it('rejects finalizer tag substitution, missing retry and malformed YAML', () => {
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      stepNamed(workflow, 'finalize', 'Verify the exact source tag').run = 'gh api --method POST git/refs -f ref=refs/tags/v0.5.0 -f sha=forged';
    })), 'step-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      jobs(workflow).finalize.permissions = { contents: 'write' };
    })), 'job-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      delete (jobs(workflow).finalize.env as Mapping).GH_REPO;
    })), 'job-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      removeStep(workflow, 'finalize', 'Verify an existing GitHub release safely');
    })), 'step-allowlist');
    expectViolation(evaluateRelease('name: Release\nname: forged\n'), 'yaml');
  });

  it('rejects publish actions that rebuild or publish a different VSIX', () => {
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      mapping(stepNamed(workflow, 'publish', 'Publish to Open VSX').with).extensionFile = 'dist/other.vsix';
    })), 'step-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      mapping(stepNamed(workflow, 'publish', 'Publish to the Visual Studio Marketplace').env).VSIX_PATH = 'dist/other.vsix';
    })), 'step-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      stepNamed(workflow, 'publish', 'Publish to Open VSX').uses = 'HaaLeo/publish-vscode-extension@v2';
    })), 'step-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      mapping(stepNamed(workflow, 'publish', 'Publish to Open VSX').with).registryUrl = RELEASE_CONTRACT.registries.marketplace.url;
    })), 'step-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      stepNamed(workflow, 'publish', 'Verify the candidate manifest, tag and digest').run = 'pnpm run build';
    })), 'step-contract');
  });

  it.each([
    ['a different script', 'bash reviewed-source/.github/scripts/release/other.sh'],
    ['a suppressed failure', 'bash reviewed-source/.github/scripts/release/compare-published.sh || true'],
    ['an inline body', 'set -euo pipefail\ntrue'],
    ['a local copy', 'bash ./compare-published.sh'],
  ])('requires the post-publish comparison to be exactly the reviewed script call, not %s', (_label, run) => {
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      stepNamed(workflow, 'publish', 'Compare post-publish registry copies').run = run;
    })), 'step-contract');
  });

  it('requires the post-publish comparison to receive only the candidate and its version', () => {
    const violations = evaluateRelease(mutate(releaseSource, (workflow) => {
      mapping(stepNamed(workflow, 'publish', 'Compare post-publish registry copies').env).VSCE_PAT = '${{ secrets.VSCE_PAT }}';
    }));
    expectViolation(violations, 'step-contract');
    expectViolation(violations, 'secret-boundary');
  });

  it('rejects suppressed, commented-out and unbounded provenance checks', () => {
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      const attestation = stepNamed(workflow, 'publish', 'Verify protected candidate attestation');
      attestation.run = `${String(attestation.run)} || true`;
    })), 'step-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      const attestation = stepNamed(workflow, 'publish', 'Verify protected candidate attestation');
      attestation.run = `set -euo pipefail\n# ${String(attestation.run).replaceAll('\n', '\n# ')}`;
    })), 'step-contract');
    expectViolation(evaluateDispatch(mutate(dispatchSource, (workflow) => {
      const verify = stepNamed(workflow, 'dispatch', 'Verify the candidate and source run');
      verify.run = `${String(verify.run)} || true`;
    })), 'step-contract');
  });

  it.each([
    ['Verify the exact source tag', 'finalize-release.sh verify'],
    ['Create the GitHub release if absent', 'finalize-release.sh create'],
    ['Verify an existing GitHub release safely', 'finalize-release.sh reconcile'],
  ])('requires %s to be exactly the reviewed script call', (name, call) => {
    const withRun = (run: string): string => mutate(releaseSource, (workflow) => {
      stepNamed(workflow, 'finalize', name).run = run;
    });
    const script = `bash reviewed-source/.github/scripts/release/${call}`;
    expect(evaluateRelease(withRun(script))).toEqual([]);
    for (const run of [`${script} || true`, `set -euo pipefail\n${script}`, `${script}\ntrue`, 'set -euo pipefail\ntrue', `${script.replace(call.split(' ')[1], 'other')}`, `bash ./${call.split(' ')[0]}`]) {
      expectViolation(evaluateRelease(withRun(run)), 'step-contract');
    }
  });

  it('rejects script steps that receive a different environment', () => {
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      mapping(stepNamed(workflow, 'publish', 'Verify the candidate manifest, tag and digest').env).VSCE_PAT = '${{ secrets.VSCE_PAT }}';
    })), 'step-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      delete mapping(stepNamed(workflow, 'publish', 'Verify protected candidate attestation').env).GH_TOKEN;
    })), 'step-contract');
    expectViolation(evaluateRelease(mutate(releaseSource, (workflow) => {
      stepNamed(workflow, 'finalize', 'Create the GitHub release if absent').env = { TAG: 'v0.0.0' };
    })), 'step-contract');
  });

  it('rejects non-literal workflow documents and an invalid release config', () => {
    expectViolation(evaluatePrepare('name: Release\njobs: &jobs {}\n'), 'yaml');
    expectViolation(evaluatePrepare('- Release\n'), 'workflow-shape');
    expectViolation(evaluatePrepare(mutate(prepareSource, (workflow) => {
      stepNamed(workflow, 'prepare', 'Verify the completed verification run').run = 'gh pr merge "$PR_NUMBER"';
    })), 'step-contract');
    expectViolation(evaluateReleaseConfigPolicy('{'), 'release-config');
  });

  it('requires the reviewed pnpm and Node.js setup in preparation and candidate jobs', () => {
    for (const [source, evaluate, job] of [
      [prepareSource, evaluatePrepare, 'prepare'],
      [candidateSource, evaluateCandidate, 'candidate'],
    ] as const) {
      const setupOptions = (workflow: Workflow, name: string): Mapping => mapping(stepNamed(workflow, job, name).with);
      const mutations: ((workflow: Workflow) => void)[] = [
        (workflow) => { delete setupOptions(workflow, 'Prepare pnpm')['node-version-file']; },
        (workflow) => { setupOptions(workflow, 'Prepare pnpm').cache = true; },
        (workflow) => { setupOptions(workflow, 'Prepare pnpm').install = true; },
        (workflow) => { stepNamed(workflow, job, 'Prepare pnpm').uses = `pnpm/setup@${staleSha}`; },
        (workflow) => { setupOptions(workflow, 'Setup Node.js')['node-version'] = '22.0.0'; },
        (workflow) => { stepNamed(workflow, job, 'Install frozen dependencies').run = 'pnpm install'; },
      ];
      for (const mutation of mutations) {
        expectViolation(evaluate(mutate(source, mutation)), 'step-contract');
      }
    }
  });

  it('requires the verified workflow-dispatch PR head in CI', () => {
    const ciSource = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(evaluateCiWorkflowPolicy(ciSource, registry)).toEqual([]);
    expect(evaluateCiWorkflowPolicy(ciSource.replace('head_sha:\n        required: true', 'head_sha:\n        required: false'), registry))
      .toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'trigger-contract' })]));
  });

  it('lists in the contract exactly the candidate keys release:candidate writes, in codepoint order', () => {
    const sourceSha = 'a'.repeat(40);
    const digest = 'b'.repeat(64);
    const artifact = {
      vsixFile: 'nestro-0.5.0.vsix',
      digestFile: 'nestro-0.5.0.vsix.sha256',
      digest,
      manifestFile: 'nestro-0.5.0.vsix.manifest.txt',
      manifestSha256: 'c'.repeat(64),
      sbomFile: 'sbom.json',
      sbomSha256: 'd'.repeat(64),
      provenanceFile: 'provenance.json',
      provenanceSha256: 'e'.repeat(64),
    } as const;
    const evidence: ReleaseCandidateEvidence = {
      sourceSha,
      runId: '42',
      runAttempt: '7',
      vsixFile: artifact.vsixFile,
      vsixSha256: digest,
      eventName: 'push',
      pullRequestHeadSha: null,
      releaseEligible: false,
    };
    const outcome = buildReleaseCandidate(
      evidence,
      '0.5.0',
      [],
      '### Features\n\n* add preview',
      { expectedSourceSha: sourceSha, expectedCiRunId: '42', candidateRunId: '43', artifact },
    );
    if (!outcome.isCandidate) {
      throw new Error('fixture candidate must build for the key-order comparison');
    }
    // jq sorts by codepoint; an explicit codepoint comparator matches that for this all-ASCII key set.
    const byCodepoint = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
    const expectedKeyOrder = Object.keys(outcome.manifest).sort(byCodepoint).join(',');
    expect(RELEASE_CONTRACT.candidateKeys.join(',')).toBe(expectedKeyOrder);
  });
});

describe('release workflow shell scripts', () => {
  const scriptDirectory = resolve(repositoryRoot, '.github/scripts/release');
  const executableScripts = ['verify-run.sh', 'verify-candidate.sh', 'verify-attestation.sh', 'finalize-release.sh', 'compare-published.sh'];
  const allScripts = [...executableScripts, 'candidate-lib.sh'];
  const scriptCalls = [
    [releaseSource, 'publish', 'Verify the candidate workflow run', 'verify-run.sh', ''],
    [releaseSource, 'publish', 'Verify the candidate manifest, tag and digest', 'verify-candidate.sh', ' publish'],
    [releaseSource, 'publish', 'Verify protected candidate attestation', 'verify-attestation.sh', ''],
    [releaseSource, 'publish', 'Compare post-publish registry copies', 'compare-published.sh', ''],
    [releaseSource, 'finalize', 'Verify the exact source tag', 'finalize-release.sh', ' verify'],
    [releaseSource, 'finalize', 'Create the GitHub release if absent', 'finalize-release.sh', ' create'],
    [releaseSource, 'finalize', 'Verify an existing GitHub release safely', 'finalize-release.sh', ' reconcile'],
    [dispatchSource, 'dispatch', 'Verify the candidate workflow run', 'verify-run.sh', ' "$SOURCE_SHA"'],
    [dispatchSource, 'dispatch', 'Verify the candidate and source run', 'verify-candidate.sh', ' dispatch'],
  ] as const;

  it('has every release script on disk and keeps the executable ones strict and free of workflow expressions', () => {
    for (const name of allScripts) {
      expect(existsSync(join(scriptDirectory, name)), name).toBe(true);
      expect(scriptSource(name), name).not.toContain('${{');
    }
    for (const name of executableScripts) {
      expect(scriptSource(name).startsWith('#!/usr/bin/env bash\n'), name).toBe(true);
      expect(scriptSource(name), name).toMatch(/^set -euo pipefail$/mu);
    }
  });

  it.each(scriptCalls)('runs %#: %s step %s through one reviewed script call', (source, job, name, script, argument) => {
    const workflow = parse(source) as Record<string, unknown>;
    const step = steps(workflow, job).find(candidate => candidate.name === name);
    expect(step?.run).toBe(`bash reviewed-source/.github/scripts/release/${script}${argument}`);
    expect(existsSync(join(scriptDirectory, script))).toBe(true);
  });

  it('hands no registry credential to any step that runs a release script', () => {
    for (const source of [releaseSource, dispatchSource]) {
      const workflow = parse(source) as Record<string, unknown>;
      for (const job of Object.keys(jobs(workflow))) {
        for (const step of steps(workflow, job).filter(candidate => String(candidate.run ?? '').includes('.github/scripts/release/'))) {
          expect(JSON.stringify(step), String(step.name)).not.toContain('secrets.');
        }
        expect(JSON.stringify(jobs(workflow)[job].env ?? {}), job).not.toContain('secrets.');
      }
    }
  });

  it('takes bundle names, workflow names and the signer path from the contract', () => {
    const { bundle, workflows } = RELEASE_CONTRACT;
    const sources = allScripts.map(scriptSource).join('\n');
    for (const literal of [bundle.candidate, bundle.sbom, bundle.provenance, bundle.manifestSuffix, workflows.signerPath, workflows.releaseCandidateName, workflows.verifyName]) {
      expect(sources, literal).not.toContain(literal);
    }
    expect(sources).toContain('release-contract.json');
  });

  it('reads every contract candidate key from the candidate manifest', () => {
    const sources = allScripts.map(scriptSource).join('\n');
    for (const key of RELEASE_CONTRACT.candidateKeys) {
      expect(sources, key).toContain(`.${key}`);
    }
  });

  it('keeps release workflow shell and Python text out of src/tools', () => {
    const toolsSource = ['releaseWorkflowPolicy', 'releaseWorkflowParts', 'releasePrepareContract', 'releaseCandidateContract', 'releaseDispatchContract', 'releasePublishContract']
      .map(name => readFileSync(resolve(repositoryRoot, `src/tools/${name}.ts`), 'utf8'))
      .join('\n');
    for (const fragment of ['gh release', 'gh attestation', 'sha256sum', 'comm -23', 'curl_args', 'python3', 'zipfile']) {
      expect(toolsSource, fragment).not.toContain(fragment);
    }
  });
});