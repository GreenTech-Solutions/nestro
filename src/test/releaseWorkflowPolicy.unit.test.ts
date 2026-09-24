import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  evaluateCiWorkflowPolicy,
  evaluateReleaseCandidateWorkflowPolicy,
  evaluateReleaseConfigPolicy,
  evaluateReleaseDispatchWorkflowPolicy,
  evaluateReleasePrepareWorkflowPolicy,
  evaluateReleaseWorkflowPolicy,
} from '../tools';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const prepareSource = readFileSync(resolve(repositoryRoot, '.github/workflows/release-prepare.yml'), 'utf8');
const candidateSource = readFileSync(resolve(repositoryRoot, '.github/workflows/release-candidate.yml'), 'utf8');
const dispatchSource = readFileSync(resolve(repositoryRoot, '.github/workflows/release-dispatch.yml'), 'utf8');
const releaseSource = readFileSync(resolve(repositoryRoot, '.github/workflows/release.yml'), 'utf8');
const releaseConfigSource = readFileSync(resolve(repositoryRoot, '.releaserc.json'), 'utf8');

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

  it('rejects source, version, digest and secret boundary substitutions in publish', () => {
    const source = releaseSource;
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      delete jobs(workflow).publish.environment;
    })), 'protected-environment');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(source, (workflow) => {
      steps(workflow, 'publish').push({ name: 'Checkout source', uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' });
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

  it('rejects suppressed, commented-out and unbounded provenance checks', () => {
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const attestation = steps(workflow, 'publish').find(step => step.name === 'Verify protected candidate attestation');
      attestation!.run = `${String(attestation!.run)} || true`;
    })), 'attestation');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const attestation = steps(workflow, 'publish').find(step => step.name === 'Verify protected candidate attestation');
      attestation!.run = `set -euo pipefail\n# ${String(attestation!.run).replaceAll('\n', '\n# ')}`;
    })), 'attestation');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const comparison = steps(workflow, 'publish').find(step => step.name === 'Compare post-publish registry copies');
      comparison!.run = 'set -euo pipefail\ntrue';
    })), 'post-publish');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const comparison = steps(workflow, 'publish').find(step => step.name === 'Compare post-publish registry copies');
      comparison!.run = String(comparison!.run).replace('--proto \'=https\' --proto-redir \'=https\' --max-redirs 3', '--location');
    })), 'post-publish');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const comparison = steps(workflow, 'publish').find(step => step.name === 'Compare post-publish registry copies');
      comparison!.run = String(comparison!.run)
        .replace('MAX_ENTRIES = 26', 'MAX_ENTRIES = 1')
        .replace('def fail(message):', 'MAX_ENTRIES = 26\n\ndef fail(message):');
    })), 'post-publish');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const comparison = steps(workflow, 'publish').find(step => step.name === 'Compare post-publish registry copies');
      comparison!.run = String(comparison!.run)
        .replace('MAX_UNCOMPRESSED_BYTES = 10485760', 'MAX_UNCOMPRESSED_BYTES = 10485760\n\nglobals().update(MAX_ENTRIES=1)');
    })), 'post-publish');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const comparison = steps(workflow, 'publish').find(step => step.name === 'Compare post-publish registry copies');
      comparison!.run = String(comparison!.run).replace('def inspect(path):', 'fail = lambda message: None\n\ndef inspect(path):');
    })), 'post-publish');
    expectViolation(evaluateReleaseDispatchWorkflowPolicy(mutate(dispatchSource, (workflow) => {
      const verify = steps(workflow, 'dispatch').find(step => step.name === 'Verify the candidate and source run');
      verify!.run = `${String(verify!.run)} || true`;
    })), 'candidate-integrity');
  });

  it('requires fail-closed finalizer shell steps', () => {
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const tag = steps(workflow, 'finalize').find(step => step.name === 'Verify the exact source tag');
      tag!.run = 'set -euo pipefail\ntrue';
    })), 'finalizer-boundary');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const create = steps(workflow, 'finalize').find(step => step.name === 'Create the GitHub release if absent');
      create!.run = `${String(create!.run)}\ntrue || true`;
    })), 'finalizer-boundary');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const existing = steps(workflow, 'finalize').find(step => step.name === 'Verify an existing GitHub release safely');
      existing!.run = String(existing!.run).replace('set -euo pipefail', 'set -euo pipefail\nset +e');
    })), 'retry-safety');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const tag = steps(workflow, 'finalize').find(step => step.name === 'Verify the exact source tag');
      tag!.run = String(tag!.run).replace('set -euo pipefail', 'set -euo pipefail\ntrap \'true\' EXIT');
    })), 'finalizer-boundary');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const tag = steps(workflow, 'finalize').find(step => step.name === 'Verify the exact source tag');
      tag!.run = 'set -euo pipefail\ntrue\nprintf "%s %s %s\\n" "git/ref/tags/" ".sourceSha" "refs/tags/v"';
    })), 'finalizer-boundary');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const create = steps(workflow, 'finalize').find(step => step.name === 'Create the GitHub release if absent');
      create!.run = 'set -euo pipefail\ntrue\nprintf "%s %s %s %s\\n" "gh release create" "candidate.json" "$VSIX_FILE" "--verify-tag"';
    })), 'finalizer-boundary');
    expectViolation(evaluateReleaseWorkflowPolicy(mutate(releaseSource, (workflow) => {
      const existing = steps(workflow, 'finalize').find(step => step.name === 'Verify an existing GitHub release safely');
      existing!.run = 'set -euo pipefail\ntrue\nprintf "%s %s %s %s %s\\n" "release download" "release upload" "cmp " "expected_names" "asset_names"';
    })), 'retry-safety');
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

  it('requires the verified workflow-dispatch PR head in CI', () => {
    const ciSource = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(evaluateCiWorkflowPolicy(ciSource)).toEqual([]);
    expect(evaluateCiWorkflowPolicy(ciSource.replace('head_sha:\n        required: true', 'head_sha:\n        required: false')))
      .toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'safe-trigger' })]));
  });
});