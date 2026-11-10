import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  evaluatePublishToolPolicy,
  evaluateReleaseCandidateWorkflowPolicy,
  evaluateReleaseDispatchWorkflowPolicy,
  evaluateReleasePrepareWorkflowPolicy,
  evaluateReleaseWorkflowPolicy,
  loadReviewedActionsRegistry,
  PUBLISH_TOOL_LOCKFILE_PATH,
  PUBLISH_TOOL_MANIFEST_PATH,
  ROOT_MANIFEST_PATH,
} from '../tools';
import type { PublishToolFiles, WorkflowViolation } from '../tools';

type Mapping = Record<string, unknown>;

const repositoryRoot = resolve(import.meta.dirname, '../..');
const registry = loadReviewedActionsRegistry(repositoryRoot);
const read = (path: string): string => readFileSync(resolve(repositoryRoot, path), 'utf8');
const releaseSource = read('.github/workflows/release.yml');
const MARKETPLACE = 'Publish to the Visual Studio Marketplace';
const INSTALL = 'Install the pinned publishing tool';
const SETUP_NODE = 'Set up Node.js for the publishing tool';
const EXPECTED_INSTALL = 'npm ci --ignore-scripts --no-audit --no-fund --prefix reviewed-source/.github/publish-tool';

function mutate(source: string, mutator: (workflow: Mapping) => void): string {
  const workflow = parse(source, { uniqueKeys: true }) as Mapping;
  mutator(workflow);
  return stringify(workflow);
}

function jobOf(workflow: Mapping, job: string): Mapping {
  return (workflow.jobs as Record<string, Mapping>)[job];
}

function stepOf(workflow: Mapping, name: string): Mapping {
  const found = (jobOf(workflow, 'publish').steps as Mapping[]).find(step => step.name === name);
  if (found === undefined) {
    throw new Error(`publish has no step named ${name}`);
  }
  return found;
}

function rules(violations: readonly WorkflowViolation[]): string[] {
  return violations.map(violation => violation.rule);
}

const evaluateRelease = (source: string): WorkflowViolation[] => evaluateReleaseWorkflowPolicy(source, registry);

describe('release publish job policy', () => {
  it('accepts the reviewed OIDC publish job', () => {
    expect(evaluateRelease(releaseSource)).toEqual([]);
  });

  it.each([
    'Check out the reviewed scripts',
    'Verify the candidate workflow run',
    'Verify protected candidate attestation',
    SETUP_NODE,
    INSTALL,
    MARKETPLACE,
    'Publish to Open VSX',
    'Compare post-publish registry copies',
  ])('rejects VSCE_PAT in the "%s" step', (name) => {
    for (const reference of [{ VSCE_PAT: '${{ secrets.VSCE_PAT }}' }, { TOKEN: '${{ env.VSCE_PAT }}' }]) {
      const violations = evaluateRelease(mutate(releaseSource, (workflow) => {
        const step = stepOf(workflow, name);
        step.env = { ...(step.env as Mapping | undefined), ...reference };
      }));

      expect(rules(violations)).toContain('secret-boundary');
    }
  });

  it('rejects VSCE_PAT in the workflow header and in job controls', () => {
    expect(rules(evaluateRelease(mutate(releaseSource, (workflow) => {
      workflow.env = { VSCE_PAT: '${{ secrets.VSCE_PAT }}' };
    })))).toContain('secret-boundary');
    expect(rules(evaluateRelease(mutate(releaseSource, (workflow) => {
      jobOf(workflow, 'publish').env = { VSCE_PAT: '${{ secrets.VSCE_PAT }}' };
    })))).toContain('secret-boundary');
  });

  it.each([
    ['a --pat flag on the script call', (step: Mapping) => { step.run = `${String(step.run)} --pat token`; }],
    ['a PAT variable', (step: Mapping) => { step.env = { ...(step.env as Mapping), PAT: 'token' }; }],
    ['a secret reference', (step: Mapping) => { step.env = { ...(step.env as Mapping), TOKEN: '${{ secrets.OVSX_PAT }}' }; }],
    ['an action in place of the script', (step: Mapping) => { step.uses = 'HaaLeo/publish-vscode-extension@v2.1.0'; }],
    ['a different script', (step: Mapping) => { step.run = 'bash reviewed-source/.github/scripts/release/other.sh'; }],
    ['a suppressed failure', (step: Mapping) => { step.run = `${String(step.run)} || true`; }],
    ['a forged VSIX path', (step: Mapping) => { step.env = { VSIX_PATH: 'dist/other.vsix' }; }],
  ])('rejects the Marketplace step with %s', (_label, change) => {
    const violations = evaluateRelease(mutate(releaseSource, (workflow) => {
      change(stepOf(workflow, MARKETPLACE));
    }));

    expect(rules(violations)).toContain('marketplace-publish');
    expect(rules(violations)).toContain('step-contract');
  });

  it.each([
    ['a missing --ignore-scripts', EXPECTED_INSTALL.replace(' --ignore-scripts', '')],
    ['a missing --prefix', EXPECTED_INSTALL.replace(' --prefix reviewed-source/.github/publish-tool', '')],
    ['npm install in place of npm ci', EXPECTED_INSTALL.replace('npm ci', 'npm install')],
    ['another prefix', EXPECTED_INSTALL.replace('publish-tool', 'other')],
    ['a chained command', `${EXPECTED_INSTALL} && npm run build`],
  ])('rejects the tool installation with %s', (_label, run) => {
    const violations = evaluateRelease(mutate(releaseSource, (workflow) => {
      stepOf(workflow, INSTALL).run = run;
    }));

    expect(rules(violations)).toContain('publish-tool-install');
  });

  it('rejects an installation step that adds a working directory or condition', () => {
    for (const extra of [{ 'working-directory': 'dist' }, { if: '${{ always() }}' }]) {
      expect(rules(evaluateRelease(mutate(releaseSource, (workflow) => {
        Object.assign(stepOf(workflow, INSTALL), extra);
      })))).toContain('publish-tool-install');
    }
  });

  it.each([
    ['a cache input', (inputs: Mapping) => { inputs.cache = 'npm'; }],
    ['a cache dependency path', (inputs: Mapping) => { inputs['cache-dependency-path'] = 'reviewed-source/.github/publish-tool/package-lock.json'; }],
    ['automatic caching left on', (inputs: Mapping) => { inputs['package-manager-cache'] = true; }],
    ['automatic caching unset', (inputs: Mapping) => { delete inputs['package-manager-cache']; }],
  ])('rejects the Node.js setup with %s', (_label, change) => {
    const violations = evaluateRelease(mutate(releaseSource, (workflow) => {
      change(stepOf(workflow, SETUP_NODE).with as Mapping);
    }));

    expect(rules(violations)).toContain('publish-node-cache');
  });

  it('rejects a missing tool installation or Node.js setup step', () => {
    for (const [name, rule] of [[INSTALL, 'publish-tool-install'], [SETUP_NODE, 'publish-node-cache'], [MARKETPLACE, 'marketplace-publish']] as const) {
      const violations = evaluateRelease(mutate(releaseSource, (workflow) => {
        const job = jobOf(workflow, 'publish');
        job.steps = (job.steps as Mapping[]).filter(step => step.name !== name);
      }));

      expect(rules(violations)).toContain(rule);
    }
  });

  it('rejects a reviewed-scripts checkout that omits the publishing tool or the Node.js version file', () => {
    for (const path of ['.github/publish-tool', '.nvmrc']) {
      const violations = evaluateRelease(mutate(releaseSource, (workflow) => {
        const inputs = stepOf(workflow, 'Check out the reviewed scripts').with as Mapping;
        inputs['sparse-checkout'] = String(inputs['sparse-checkout']).replace(`${path}\n`, '');
      }));

      expect(rules(violations)).toContain('step-contract');
    }
  });
});

describe('id-token boundary', () => {
  const finalizeAndWorkflowLevel: [string, (workflow: Mapping) => void][] = [
    ['the finalize job', (workflow) => { jobOf(workflow, 'finalize').permissions = { ...(jobOf(workflow, 'finalize').permissions as Mapping), 'id-token': 'write' }; }],
    ['the workflow level', (workflow) => { workflow.permissions = { 'id-token': 'write' }; }],
    ['the finalize job as write-all', (workflow) => { jobOf(workflow, 'finalize').permissions = 'write-all'; }],
  ];

  it.each(finalizeAndWorkflowLevel)('rejects id-token on %s of the release workflow', (_label, change) => {
    expect(rules(evaluateRelease(mutate(releaseSource, change)))).toContain('id-token-boundary');
  });

  it('requires id-token: write on the publish job', () => {
    const violations = evaluateRelease(mutate(releaseSource, (workflow) => {
      delete (jobOf(workflow, 'publish').permissions as Mapping)['id-token'];
    }));

    expect(rules(violations)).toContain('job-contract');
  });

  it.each([
    ['release-prepare.yml', evaluateReleasePrepareWorkflowPolicy],
    ['release-candidate.yml', evaluateReleaseCandidateWorkflowPolicy],
    ['release-dispatch.yml', evaluateReleaseDispatchWorkflowPolicy],
  ])('rejects id-token anywhere in %s', (name, evaluate) => {
    const source = read(`.github/workflows/${name}`);
    const jobIds = Object.keys((parse(source) as Mapping).jobs as Mapping);
    const atWorkflowLevel = mutate(source, (workflow) => { workflow.permissions = { 'id-token': 'write' }; });

    expect(rules(evaluate(atWorkflowLevel, registry))).toContain('id-token-boundary');
    for (const jobId of jobIds) {
      const atJob = mutate(source, (workflow) => {
        jobOf(workflow, jobId).permissions = { ...(jobOf(workflow, jobId).permissions as Mapping | undefined), 'id-token': 'write' };
      });

      expect(rules(evaluate(atJob, registry))).toContain('id-token-boundary');
    }
  });
});

describe('publishing tool files', () => {
  const files: PublishToolFiles = {
    rootManifest: read(ROOT_MANIFEST_PATH),
    toolLockfile: read(PUBLISH_TOOL_LOCKFILE_PATH),
    toolManifest: read(PUBLISH_TOOL_MANIFEST_PATH),
  };
  const rootVersion = (JSON.parse(files.rootManifest) as { devDependencies: Record<string, string> }).devDependencies['@vscode/vsce'];

  function withManifest(change: (manifest: Mapping) => void): PublishToolFiles {
    const manifest = JSON.parse(files.toolManifest) as Mapping;
    change(manifest);
    return { ...files, toolManifest: JSON.stringify(manifest) };
  }

  function withLockfile(change: (lockfile: { lockfileVersion: unknown; packages: Record<string, Mapping | undefined> }) => void): PublishToolFiles {
    const lockfile = JSON.parse(files.toolLockfile) as { lockfileVersion: unknown; packages: Record<string, Mapping | undefined> };
    change(lockfile);
    return { ...files, toolLockfile: JSON.stringify(lockfile) };
  }

  function expectViolation(candidate: PublishToolFiles, text: string): void {
    const violations = evaluatePublishToolPolicy(candidate);

    expect(rules(violations)).toContain('publish-tool');
    expect(violations.map(violation => violation.message).join('\n')).toContain(text);
  }

  it('accepts the reviewed manifest and lockfile, pinned to the root vsce version', () => {
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(evaluatePublishToolPolicy(files)).toEqual([]);
  });

  it('rejects a vsce version that differs from the root devDependency', () => {
    expectViolation(withManifest((manifest) => { manifest.dependencies = { '@vscode/vsce': '4.0.0' }; }), 'equal to the root devDependency');
    expectViolation({ ...files, rootManifest: files.rootManifest.replace(`"@vscode/vsce": "${rootVersion}"`, '"@vscode/vsce": "4.0.0"') }, 'equal to the root devDependency');
  });

  it.each([
    ['a version range', { '@vscode/vsce': `^${rootVersion}` }],
    ['a second dependency', { '@vscode/vsce': rootVersion, typescript: '6.0.3' }],
    ['no dependency', {}],
    ['another package', { ovsx: '0.10.0' }],
  ])('rejects a manifest with %s', (_label, dependencies) => {
    expectViolation(withManifest((manifest) => { manifest.dependencies = dependencies; }), PUBLISH_TOOL_MANIFEST_PATH);
  });

  it.each([
    ['install scripts', { scripts: { install: 'node x.js' } }],
    ['development dependencies', { devDependencies: { vitest: '4.1.11' } }],
    ['overrides', { overrides: { semver: '1.0.0' } }],
    ['a public package', { private: false }],
  ])('rejects a manifest with %s', (_label, change) => {
    expectViolation(withManifest((manifest) => { Object.assign(manifest, change); }), PUBLISH_TOOL_MANIFEST_PATH);
  });

  it('rejects a locked package without integrity', () => {
    const candidate = withLockfile((lockfile) => {
      const [path] = Object.keys(lockfile.packages).filter(key => key.startsWith('node_modules/'));
      delete lockfile.packages[path]?.integrity;
    });

    expectViolation(candidate, 'must carry a sha512 integrity');
  });

  it.each([
    ['sha1', 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA='],
    ['an empty value', ''],
    ['a number', 7],
  ])('rejects a locked package with %s as integrity', (_label, integrity) => {
    const candidate = withLockfile((lockfile) => {
      const [path] = Object.keys(lockfile.packages).filter(key => key.startsWith('node_modules/'));
      lockfile.packages[path] = { ...lockfile.packages[path], integrity };
    });

    expectViolation(candidate, 'must carry a sha512 integrity');
  });

  it.each([
    ['another host', 'https://registry.example.com/semver/-/semver-1.0.0.tgz'],
    ['plain http', Object.assign(new URL('https://registry.npmjs.org/semver/-/semver-1.0.0.tgz'), { protocol: 'http:' }).href],
    ['a git source', 'git+https://github.com/npm/node-semver.git#abc'],
    ['a lookalike host', 'https://registry.npmjs.org.evil.test/semver/-/semver-1.0.0.tgz'],
    ['a file source', 'file:../semver'],
  ])('rejects a locked package resolved from %s', (_label, resolved) => {
    const candidate = withLockfile((lockfile) => {
      const [path] = Object.keys(lockfile.packages).filter(key => key.startsWith('node_modules/'));
      lockfile.packages[path] = { ...lockfile.packages[path], resolved };
    });

    expectViolation(candidate, 'must be resolved from https://registry.npmjs.org/');
  });

  it('rejects a locked package without a resolved URL', () => {
    const candidate = withLockfile((lockfile) => {
      const [path] = Object.keys(lockfile.packages).filter(key => key.startsWith('node_modules/'));
      delete lockfile.packages[path]?.resolved;
    });

    expectViolation(candidate, 'must be resolved from https://registry.npmjs.org/');
  });

  it('rejects linked and non-installed lockfile entries', () => {
    expectViolation(withLockfile((lockfile) => { lockfile.packages['../elsewhere'] = { link: true }; }), 'is not an installed registry package');
    expectViolation(withLockfile((lockfile) => { lockfile.packages['node_modules/linked'] = { link: true, resolved: '../linked' }; }), 'node_modules/linked must be resolved');
  });

  it.each([2, 1, '3', undefined])('rejects lockfileVersion %s', (version) => {
    expectViolation(withLockfile((lockfile) => { lockfile.lockfileVersion = version; }), 'lockfileVersion must be 3');
  });

  it('rejects a lockfile root that differs from the manifest', () => {
    expectViolation(withLockfile((lockfile) => { lockfile.packages[''] = { name: 'nestro-publish-tool', dependencies: { '@vscode/vsce': '4.0.0' } }; }), 'root package must match the manifest');
    expectViolation(withLockfile((lockfile) => { delete lockfile.packages['']; }), 'root package must match the manifest');
  });

  it('rejects a locked vsce at a version other than the manifest pin', () => {
    expectViolation(withLockfile((lockfile) => {
      lockfile.packages['node_modules/@vscode/vsce'] = { ...lockfile.packages['node_modules/@vscode/vsce'], version: '4.0.0' };
    }), 'must be locked at the manifest version');
    expectViolation(withLockfile((lockfile) => { delete lockfile.packages['node_modules/@vscode/vsce']; }), 'must be locked at the manifest version');
  });

  it.each([
    ['the root manifest', { ...files, rootManifest: '{' }],
    ['the tool manifest', { ...files, toolManifest: '[]' }],
    ['the lockfile', { ...files, toolLockfile: 'not json' }],
  ])('reports an unreadable %s', (_label, candidate) => {
    expect(rules(evaluatePublishToolPolicy(candidate))).toContain('publish-tool');
  });
});