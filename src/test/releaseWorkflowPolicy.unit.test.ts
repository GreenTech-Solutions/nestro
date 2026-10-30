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
  loadReviewedActionsRegistry,
  RELEASE_CONTRACT,
  reviewedActionReference,
} from '../tools';
import type { ReleaseCandidateEvidence } from '../tools';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const prepareSource = readFileSync(resolve(repositoryRoot, '.github/workflows/release-prepare.yml'), 'utf8');
const candidateSource = readFileSync(resolve(repositoryRoot, '.github/workflows/release-candidate.yml'), 'utf8');
const dispatchSource = readFileSync(resolve(repositoryRoot, '.github/workflows/release-dispatch.yml'), 'utf8');
const releaseSource = readFileSync(resolve(repositoryRoot, '.github/workflows/release.yml'), 'utf8');
const releaseConfigSource = readFileSync(resolve(repositoryRoot, '.releaserc.json'), 'utf8');
const staleSha = 'e'.repeat(40);

function scriptSource(name: string): string {
  return readFileSync(resolve(repositoryRoot, '.github/scripts/release', name), 'utf8');
}

function mutate(source: string, mutator: (workflow: Record<string, unknown>) => void): string {
  const workflow = parse(source, { uniqueKeys: true }) as Record<string, unknown>;
  mutator(workflow);
  return stringify(workflow);
}

function jobs(workflow: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return workflow.jobs as Record<string, Record<string, unknown>>;
}

function steps(workflow: Record<string, unknown>, job: string): Record<string, unknown>[] {
  return jobs(workflow)[job].steps as Record<string, unknown>[];
}

function expectViolation(violations: readonly { readonly rule: string }[], rule: string): void {
  expect(violations).toEqual(expect.arrayContaining([expect.objectContaining({ rule })]));
}

describe('release workflow policies', () => {
  it('accepts the reviewed preparation, candidate, dispatch, publish/finalizer and config contracts', () => {
    expect(evaluateReleasePrepareWorkflowPolicy(prepareSource)).toEqual([]);
    expect(evaluateReleaseCandidateWorkflowPolicy(candidateSource)).toEqual([]);
    expect(evaluateReleaseDispatchWorkflowPolicy(dispatchSource)).toEqual([]);
    expect(evaluateReleaseWorkflowPolicy(releaseSource)).toEqual([]);
    expect(evaluateReleaseConfigPolicy(releaseConfigSource)).toEqual([]);
  });

  it('rejects implicit triggers and privilege changes in preparation', () => {
    expectViolation(evaluateReleasePrepareWorkflowPolicy(mutate(prepareSource, (workflow) => {
      (workflow.on as Record<string, unknown>).push = { branches: ['master'] };
    })), 'release-trigger');
    expectViolation(evaluateReleasePrepareWorkflowPolicy(mutate(prepareSource, (workflow) => {
      (workflow.permissions as Record<string, unknown>).issues = 'write';
    })), 'least-permissions');
    expectViolation(evaluateReleasePrepareWorkflowPolicy(mutate(prepareSource, (workflow) => {
      (jobs(workflow).prepare.env as Record<string, unknown>).VSCE_PAT = '${{ secrets.VSCE_PAT }}';
    })), 'secret-boundary');
    expectViolation(evaluateReleasePrepareWorkflowPolicy(mutate(prepareSource, (workflow) => {
      steps(workflow, 'prepare').push({ name: 'Unexpected side effect', run: 'gh api --method DELETE' });
    })), 'step-allowlist');
  });

  it('rejects stale master, duplicate version pull requests and forged dispatch identity', () => {
    const withoutStaleCheck = mutate(prepareSource, (workflow) => {
      jobs(workflow).prepare.steps = steps(workflow, 'prepare')
        .filter(step => step.name !== 'Assert checkout identity');
    });
    expectViolation(evaluateReleasePrepareWorkflowPolicy(withoutStaleCheck), 'exact-checkout');

    const withoutDuplicateCheck = mutate(prepareSource, (workflow) => {
      jobs(workflow).prepare.steps = steps(workflow, 'prepare')
        .filter(step => step.name !== 'Reject competing release pull requests');
    });
    expectViolation(evaluateReleasePrepareWorkflowPolicy(withoutDuplicateCheck), 'duplicate-version-pr');

    const withoutCurrentMasterParent = mutate(prepareSource, (workflow) => {
      const competing = steps(workflow, 'prepare').find(step => step.name === 'Reject competing release pull requests');
      competing!.run = String(competing!.run).replace('$(jq -r \'.parents[0].sha\' <<<"$commit")', 'forged-parent');
    });
    expectViolation(evaluateReleasePrepareWorkflowPolicy(withoutCurrentMasterParent), 'duplicate-version-pr');

    const forgedDispatch = mutate(prepareSource, (workflow) => {
      const dispatch = steps(workflow, 'prepare').find(step => step.name === 'Dispatch exact-head verification for the version pull request');
      if (dispatch !== undefined) {
        dispatch.run = 'gh workflow run ci.yml --ref "$PR_BRANCH" -f "pr_number=$OTHER"';
      }
    });
    expectViolation(evaluateReleasePrepareWorkflowPolicy(forgedDispatch), 'dispatch-identity');

    const changedHeadAfterValidation = mutate(prepareSource, (workflow) => {
      const resolvePullRequest = steps(workflow, 'prepare').find(step => step.name === 'Resolve the exact version pull request');
      resolvePullRequest!.run = String(resolvePullRequest!.run)
        .replace('test "$head_sha" = "$EXISTING_HEAD_SHA"', 'test -n "$head_sha"');
    });
    expectViolation(evaluateReleasePrepareWorkflowPolicy(changedHeadAfterValidation), 'dispatch-identity');
  });

  it('rejects candidate artifacts that are not frozen to the exact run', () => {
    expectViolation(evaluateReleaseCandidateWorkflowPolicy(mutate(candidateSource, (workflow) => {
      const download = steps(workflow, 'candidate').find(step => step.name === 'Download the exact verified evidence');
      (download?.with as Record<string, unknown>)['run-id'] = '42';
    })), 'exact-artifact');
    expectViolation(evaluateReleaseCandidateWorkflowPolicy(mutate(candidateSource, (workflow) => {
      const checkout = steps(workflow, 'candidate').find(step => String(step.uses).startsWith('actions/checkout@'));
      (checkout?.with as Record<string, unknown>).ref = 'master';
    })), 'exact-checkout');
    expectViolation(evaluateReleaseCandidateWorkflowPolicy(mutate(candidateSource, (workflow) => {
      steps(workflow, 'candidate').find(step => step.name === 'Build the candidate manifest')!.run = 'pnpm run build';
    })), 'single-build');
    expectViolation(evaluateReleaseCandidateWorkflowPolicy(mutate(candidateSource, (workflow) => {
      (jobs(workflow).candidate.permissions as Record<string, unknown>).contents = 'write';
    })), 'job-contract');
  });

  it('rejects dispatches that substitute the candidate run, artifact, source tag or publish ref', () => {
    expectViolation(evaluateReleaseDispatchWorkflowPolicy(mutate(dispatchSource, (workflow) => {
      delete (jobs(workflow).dispatch.env as Record<string, unknown>).GH_REPO;
    })), 'job-contract');
    expectViolation(evaluateReleaseDispatchWorkflowPolicy(mutate(dispatchSource, (workflow) => {
      const resolveArtifact = steps(workflow, 'dispatch').find(step => step.name === 'Resolve the exact candidate artifact');
      resolveArtifact!.run = 'artifacts="$(gh api repos/example/actions/runs/42/artifacts)"\ncount=0';
    })), 'exact-artifact');
    expectViolation(evaluateReleaseDispatchWorkflowPolicy(mutate(dispatchSource, (workflow) => {
      const verify = steps(workflow, 'dispatch').find(step => step.name === 'Verify the candidate and source run');
      verify!.run = 'test "$(jq -r \'.head_sha\' <<<"$ci_run")" = forged';
    })), 'candidate-integrity');
    expectViolation(evaluateReleaseDispatchWorkflowPolicy(mutate(dispatchSource, (workflow) => {
      const tag = steps(workflow, 'dispatch').find(step => step.name === 'Create or verify the exact source tag');
      tag!.run = 'gh api --method POST repos/example/git/refs -f ref=refs/tags/v0.5.0 -f sha=forged';
    })), 'exact-tag');
    expectViolation(evaluateReleaseDispatchWorkflowPolicy(mutate(dispatchSource, (workflow) => {
      const dispatch = steps(workflow, 'dispatch').find(step => step.name === 'Dispatch protected publish on the tag');
      dispatch!.run = 'gh workflow run release.yml --ref "$OTHER_TAG" -f "candidate_run_id=$OTHER" -f "artifact_id=$OTHER"';
    })), 'dispatch-identity');
  });

  it('keeps the sidecar digest check relative to the bundle directory in the shared script library', () => {
    expect(scriptSource('candidate-lib.sh')).toContain('(cd "$1" && sha256sum --check --strict "$digest_file")');
  });

  it('rejects source, version, digest and secret boundary substitutions in publish', () => {
    const source = releaseSource;
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      delete jobs(workflow).publish.environment;
    })), 'protected-environment');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      steps(workflow, 'publish').push({ name: 'Checkout source', uses: reviewedActionReference('actions/checkout') });
    })), 'step-allowlist');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      const verify = steps(workflow, 'publish').find(step => step.name === 'Verify the candidate manifest, tag and digest');
      verify!.run = 'test -n candidate.json';
    })), 'candidate-integrity');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      jobs(workflow).publish.env = { OVSX_PAT: '${{ secrets.OVSX_PAT }}' };
    })), 'secret-boundary');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      const download = steps(workflow, 'publish').find(step => step.name === 'Download the exact candidate artifact');
      (download?.with as Record<string, unknown>)['artifact-ids'] = 'forged';
    })), 'exact-artifact');
  });

  it.each(['dispatch', 'publish', 'finalize'] as const)('requires the %s job to check out only the reviewed scripts and contract at the workflow commit', (job) => {
    const source = job === 'dispatch' ? dispatchSource : releaseSource;
    const evaluate = job === 'dispatch' ? evaluateReleaseDispatchWorkflowPolicy : evaluateReleaseWorkflowPolicy;
    const scriptCheckout = (workflow: Record<string, unknown>): Record<string, unknown> =>
      steps(workflow, job).find(step => step.name === 'Check out the reviewed scripts')!;
    const withOptions = (workflow: Record<string, unknown>): Record<string, unknown> =>
      scriptCheckout(workflow).with as Record<string, unknown>;
    const mutations: ((workflow: Record<string, unknown>) => void)[] = [
      (workflow) => { delete withOptions(workflow)['persist-credentials']; },
      (workflow) => { withOptions(workflow)['persist-credentials'] = true; },
      (workflow) => { withOptions(workflow).ref = '${{ steps.manifest.outputs.source-sha }}'; },
      (workflow) => { delete withOptions(workflow).ref; },
      (workflow) => { withOptions(workflow)['sparse-checkout'] = '.'; },
      (workflow) => { withOptions(workflow)['sparse-checkout'] = '.github/scripts\n'; },
      (workflow) => { delete withOptions(workflow)['sparse-checkout']; },
      (workflow) => { withOptions(workflow)['sparse-checkout-cone-mode'] = true; },
      (workflow) => { withOptions(workflow).path = '.'; },
      (workflow) => { scriptCheckout(workflow).uses = 'actions/checkout@v7'; },
      (workflow) => { jobs(workflow)[job].steps = steps(workflow, job).filter(step => step.name !== 'Check out the reviewed scripts'); },
    ];
    expect(evaluate(source)).toEqual([]);
    for (const mutation of mutations) {
      expectViolation(evaluate(mutate(source, mutation)), 'script-checkout');
    }
  });

  it.each(['dispatch', 'publish', 'finalize'] as const)('rejects a script checkout that is not the first %s step', (job) => {
    const source = job === 'dispatch' ? dispatchSource : releaseSource;
    const evaluate = job === 'dispatch' ? evaluateReleaseDispatchWorkflowPolicy : evaluateReleaseWorkflowPolicy;
    expectViolation(evaluate(mutate(source, (workflow) => {
      const jobSteps = steps(workflow, job);
      const [checkout] = jobSteps.splice(0, 1);
      jobSteps.splice(1, 0, checkout);
    })), 'script-checkout');
  });

  it('rejects a second checkout, or a checkout with a shell body, in the publish job', () => {
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      steps(workflow, 'publish').push({ name: 'Checkout source', uses: reviewedActionReference('actions/checkout') });
    })), 'publish-boundary');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      steps(workflow, 'publish').find(step => step.name === 'Check out the reviewed scripts')!.run = 'pnpm install';
    })), 'script-checkout');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      steps(workflow, 'finalize').push({ name: 'Checkout source', uses: reviewedActionReference('actions/checkout') });
    })), 'publish-boundary');
  });

  it('rejects finalizer checkout/build, tag substitution, missing retry and malformed YAML', () => {
    const source = releaseSource;
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      steps(workflow, 'finalize').push({ name: 'Build again', run: 'pnpm run build' });
    })), 'step-allowlist');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      const tagStep = steps(workflow, 'finalize').find(step => step.name === 'Verify the exact source tag');
      tagStep!.run = 'gh api --method POST git/refs -f ref=refs/tags/v0.5.0 -f sha=forged';
    })), 'finalizer-boundary');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      jobs(workflow).finalize.permissions = { contents: 'write' };
    })), 'finalizer-boundary');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      delete (jobs(workflow).finalize.env as Record<string, unknown>).GH_REPO;
    })), 'finalizer-boundary');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      jobs(workflow).finalize.steps = steps(workflow, 'finalize')
        .filter(step => step.name !== 'Verify an existing GitHub release safely');
    })), 'retry-safety');
    expectViolation(evaluateReleaseWorkflowPolicy('name: Release\nname: forged\n'), 'yaml');
  });

  it('rejects publish actions that rebuild or publish a different VSIX', () => {
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const marketplace = steps(workflow, 'publish').find(step => step.name === 'Publish to the Visual Studio Marketplace');
      (marketplace!.with as Record<string, unknown>).extensionFile = 'dist/other.vsix';
    })), 'publish-bytes');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const openVsx = steps(workflow, 'publish').find(step => step.name === 'Publish to Open VSX');
      openVsx!.uses = 'HaaLeo/publish-vscode-extension@v2';
    })), 'secret-boundary');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const verify = steps(workflow, 'publish').find(step => step.name === 'Verify the candidate manifest, tag and digest');
      verify!.run = 'pnpm run build';
    })), 'candidate-integrity');
  });

  it.each([
    ['a different script', 'bash reviewed-source/.github/scripts/release/other.sh'],
    ['a suppressed failure', 'bash reviewed-source/.github/scripts/release/compare-published.sh || true'],
    ['an inline body', 'set -euo pipefail\ntrue'],
    ['a local copy', 'bash ./compare-published.sh'],
  ])('requires the post-publish comparison to be exactly the reviewed script call, not %s', (_label, run) => {
    expect(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      steps(workflow, 'publish').find(step => step.name === 'Compare post-publish registry copies')!.run = run;
    }))).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'post-publish' })]));
  });

  it('requires the post-publish comparison to receive only the candidate and its version', () => {
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      (steps(workflow, 'publish').find(step => step.name === 'Compare post-publish registry copies')!.env as Record<string, unknown>).VSCE_PAT = '${{ secrets.VSCE_PAT }}';
    })), 'post-publish');
  });

  it('rejects suppressed, commented-out and unbounded provenance checks', () => {
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const attestation = steps(workflow, 'publish').find(step => step.name === 'Verify protected candidate attestation');
      attestation!.run = `${String(attestation!.run)} || true`;
    })), 'attestation');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const attestation = steps(workflow, 'publish').find(step => step.name === 'Verify protected candidate attestation');
      attestation!.run = `set -euo pipefail\n# ${String(attestation!.run).replaceAll('\n', '\n# ')}`;
    })), 'attestation');
    expectViolation(evaluateReleaseDispatchWorkflowPolicy(mutate(dispatchSource, (workflow) => {
      const verify = steps(workflow, 'dispatch').find(step => step.name === 'Verify the candidate and source run');
      verify!.run = `${String(verify!.run)} || true`;
    })), 'candidate-integrity');
  });

  it.each([
    ['Verify the exact source tag', 'finalizer-boundary', 'finalize-release.sh verify'],
    ['Create the GitHub release if absent', 'finalizer-boundary', 'finalize-release.sh create'],
    ['Verify an existing GitHub release safely', 'retry-safety', 'finalize-release.sh reconcile'],
  ])('requires %s to be exactly the reviewed fail-closed script call', (name, rule, call) => {
    const withRun = (run: string): string => mutate(releaseSource, (workflow) => {
      steps(workflow, 'finalize').find(step => step.name === name)!.run = run;
    });
    const script = `bash reviewed-source/.github/scripts/release/${call}`;
    expect(evaluateReleaseWorkflowPolicy(withRun(script))).toEqual([]);
    for (const run of [`${script} || true`, `set -euo pipefail\n${script}`, `${script}\ntrue`, 'set -euo pipefail\ntrue', `${script.replace(call.split(' ')[1], 'other')}`, `bash ./${call.split(' ')[0]}`]) {
      expectViolation(evaluateReleaseWorkflowPolicy(withRun(run)), rule);
    }
  });

  it('rejects script steps that receive a different environment', () => {
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      (steps(workflow, 'publish').find(step => step.name === 'Verify the candidate manifest, tag and digest')!.env as Record<string, unknown>).VSCE_PAT = '${{ secrets.VSCE_PAT }}';
    })), 'candidate-integrity');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      delete (steps(workflow, 'publish').find(step => step.name === 'Verify protected candidate attestation')!.env as Record<string, unknown>).GH_TOKEN;
    })), 'attestation');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      steps(workflow, 'finalize').find(step => step.name === 'Create the GitHub release if absent')!.env = { TAG: 'v0.0.0' };
    })), 'finalizer-boundary');
  });

  it('rejects an analyze step that overrides the release configuration path', () => {
    expectViolation(evaluateReleasePrepareWorkflowPolicy(mutate(prepareSource, (workflow) => {
      steps(workflow, 'prepare').find(step => step.name === 'Analyze and prepare the next release')!.env = { RELEASE_CONFIG: 'other.json' };
    })), 'isolated-analysis');
  });

  it('rejects non-literal workflow documents and forbidden preparation side effects', () => {
    expectViolation(evaluateReleasePrepareWorkflowPolicy('name: Release\njobs: &jobs {}\n'), 'yaml');
    expectViolation(evaluateReleasePrepareWorkflowPolicy('- Release\n'), 'workflow-shape');
    expectViolation(evaluateReleasePrepareWorkflowPolicy(mutate(prepareSource, (workflow) => {
      steps(workflow, 'prepare').find(step => step.name === 'Verify the completed verification run')!.run = 'gh pr merge "$PR_NUMBER"';
    })), 'no-merge');
    expectViolation(evaluateReleaseConfigPolicy('{'), 'release-config');
  });

  it('requires exact source identity checks in preparation and candidate jobs', () => {
    expectViolation(evaluateReleasePrepareWorkflowPolicy(mutate(prepareSource, (workflow) => {
      const verify = steps(workflow, 'prepare').find(step => step.name === 'Verify the completed verification run');
      verify!.run = 'gh api actions/runs/42';
    })), 'release-run-identity');
    expectViolation(evaluateReleaseCandidateWorkflowPolicy(mutate(candidateSource, (workflow) => {
      const verify = steps(workflow, 'candidate').find(step => step.name === 'Verify the completed verification run');
      verify!.run = 'gh api actions/runs/42';
    })), 'release-run-identity');
  });

  it('requires the reviewed pnpm and Node.js setup in preparation and candidate jobs', () => {
    for (const [source, evaluate, job] of [
      [prepareSource, evaluateReleasePrepareWorkflowPolicy, 'prepare'],
      [candidateSource, evaluateReleaseCandidateWorkflowPolicy, 'candidate'],
    ] as const) {
      const setupOptions = (workflow: Record<string, unknown>, name: string): Record<string, unknown> =>
        steps(workflow, job).find(step => step.name === name)!.with as Record<string, unknown>;
      expectViolation(evaluate(mutate(source, (workflow) => {
        delete setupOptions(workflow, 'Prepare pnpm')['node-version-file'];
      })), 'toolchain');
      expectViolation(evaluate(mutate(source, (workflow) => {
        setupOptions(workflow, 'Prepare pnpm').cache = true;
      })), 'toolchain');
      expectViolation(evaluate(mutate(source, (workflow) => {
        setupOptions(workflow, 'Prepare pnpm').install = true;
      })), 'toolchain');
      expectViolation(evaluate(mutate(source, (workflow) => {
        steps(workflow, job).find(step => step.name === 'Prepare pnpm')!.uses = `pnpm/setup@${staleSha}`;
      })), 'toolchain');
      expectViolation(evaluate(mutate(source, (workflow) => {
        setupOptions(workflow, 'Setup Node.js')['node-version'] = '22.0.0';
      })), 'toolchain');
      expectViolation(evaluate(mutate(source, (workflow) => {
        steps(workflow, job).find(step => step.name === 'Install frozen dependencies')!.run = 'pnpm install';
      })), 'frozen-install');
    }
  });

  it('requires the verified workflow-dispatch PR head in CI', () => {
    const ciSource = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    const registry = loadReviewedActionsRegistry(repositoryRoot);
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
    const toolsSource = readFileSync(resolve(repositoryRoot, 'src/tools/releaseWorkflowPolicy.ts'), 'utf8');
    for (const fragment of ['gh release', 'gh attestation', 'sha256sum', 'comm -23', 'curl_args', 'python3', 'zipfile']) {
      expect(toolsSource, fragment).not.toContain(fragment);
    }
  });
});