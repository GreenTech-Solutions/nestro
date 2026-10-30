import { mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readEvidenceFile, verifyEvidenceBundle } from '../tools';
import {
  downloadAndUnzipVSCode,
  runTests,
  runVSCodeCommand,
} from '@vscode/test-electron';
import { removeFixturePath } from './fixtures/removeFixturePath';
import { describeError } from '../shared';

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SOCKET_FILE_NAME_LENGTH = '1.12-main.sock'.length;
const SOCKET_PATH_LIMITS: Readonly<Record<string, number>> = { darwin: 103, linux: 107 };

interface PackagedSmokeOptions {
  readonly artifactDir: string;
  readonly expectedSha: string;
  readonly channel: 'minimum' | 'stable';
}

interface VSCodeCommandRunner {
  (
    args: readonly string[],
    options: {
      readonly cachePath: string;
      readonly reuseMachineInstall: boolean;
      readonly version: '1.125.0' | 'stable';
    },
  ): Promise<unknown>;
}

export interface PackagedSmokeDependencies {
  readonly verifyEvidence: (artifactDir: string, expectedSha: string) => Promise<string>;
  readonly createTempRoot: () => Promise<string>;
  readonly createDriver: (root: string) => Promise<string>;
  readonly prepareWorkspace: (workspaceDir: string) => Promise<void>;
  readonly download: (version: '1.125.0' | 'stable', cachePath: string) => Promise<string>;
  readonly install: (
    vsixPath: string,
    version: '1.125.0' | 'stable',
    cachePath: string,
    userDataDir: string,
    extensionsDir: string,
  ) => Promise<void>;
  readonly launch: (
    executablePath: string,
    driverDir: string,
    runnerPath: string,
    userDataDir: string,
    extensionsDir: string,
    workspaceDir: string,
  ) => Promise<number>;
  readonly cleanup: (root: string) => Promise<void>;
}

export function parsePackagedSmokeArgs(argv: readonly string[]): PackagedSmokeOptions {
  if (argv.length !== 6 || argv[0] !== '--artifact-dir' || argv[2] !== '--expected-sha' || argv[4] !== '--channel') {
    throw new Error('usage: test:packaged --artifact-dir <directory> --expected-sha <full-sha> --channel <minimum|stable>');
  }
  if (!FULL_SHA_PATTERN.test(argv[3])) {
    throw new Error('--expected-sha must be a full lowercase 40-character commit SHA');
  }
  if (argv[5] !== 'minimum' && argv[5] !== 'stable') {
    throw new Error('--channel must be minimum or stable');
  }
  return { artifactDir: argv[1], expectedSha: argv[3], channel: argv[5] };
}

export async function verifyDownloadedEvidence(artifactDir: string, expectedSha: string): Promise<string> {
  const canonicalDir = await realpath(artifactDir);
  const vsixFiles = (await readdir(canonicalDir)).filter(entry => entry.endsWith('.vsix'));
  if (vsixFiles.length !== 1) {
    throw new Error(`downloaded artifact must contain exactly one VSIX, found ${vsixFiles.length}`);
  }
  const vsixFile = basename(vsixFiles[0]);
  const evidence = await readEvidenceFile(canonicalDir);
  if (evidence.sourceSha !== expectedSha || evidence.releaseEligible !== false || evidence.vsixFile !== vsixFile) {
    throw new Error('downloaded evidence identity does not match the exact tested SHA or evidence-only contract');
  }
  await verifyEvidenceBundle(canonicalDir, evidence);
  return join(canonicalDir, vsixFile);
}

async function createDriverExtension(root: string): Promise<string> {
  const driverDir = join(root, 'driver');
  await mkdir(driverDir, { recursive: true });
  await writeFile(join(driverDir, 'package.json'), `${JSON.stringify({
    name: 'nestro-packaged-smoke-driver',
    displayName: 'Nestro packaged smoke driver',
    publisher: 'nestro',
    version: '0.0.0',
    engines: { vscode: '^1.125.0' },
    main: './extension.cjs',
    activationEvents: ['*'],
  }, undefined, 2)}\n`, 'utf8');
  await writeFile(join(driverDir, 'extension.cjs'), `exports.activate = () => undefined;\n`, 'utf8');
  return driverDir;
}

export function runPackagedSmoke(options: PackagedSmokeOptions, cwd: string): Promise<void> {
  return runPackagedSmokeWithDependencies(options, cwd, createNodePackagedSmokeDependencies());
}

export async function runPackagedSmokeWithDependencies(
  options: PackagedSmokeOptions,
  cwd: string,
  dependencies: PackagedSmokeDependencies,
): Promise<void> {
  // Verification deliberately precedes temp-root creation and every side effect:
  // substituted bytes or identity can never reach the VS Code installer.
  const vsixPath = await dependencies.verifyEvidence(resolve(cwd, options.artifactDir), options.expectedSha);
  const root = await dependencies.createTempRoot();
  try {
    const cachePath = join(root, 'cache');
    const userDataDir = join(root, 'u');
    const extensionsDir = join(root, 'extensions');
    const workspaceDir = join(root, 'workspace');
    const driverDir = await dependencies.createDriver(root);
    assertSmokeSocketPathFits(userDataDir, process.platform);
    await dependencies.prepareWorkspace(workspaceDir);
    const version = options.channel === 'minimum' ? '1.125.0' : 'stable';
    const vscodeExecutablePath = await dependencies.download(version, cachePath);
    await dependencies.install(vsixPath, version, cachePath, userDataDir, extensionsDir);
    const exitCode = await dependencies.launch(
      vscodeExecutablePath,
      driverDir,
      resolve(cwd, 'out/test/packagedActivationRunner.js'),
      userDataDir,
      extensionsDir,
      workspaceDir,
    );
    if (exitCode !== 0) {
      throw new Error(`packaged Extension Host exited with code ${exitCode}`);
    }
  }
  finally {
    await dependencies.cleanup(root);
  }
}

export function createNodePackagedSmokeDependencies(): PackagedSmokeDependencies {
  return {
    verifyEvidence: verifyDownloadedEvidence,
    createTempRoot: async () => mkdtemp(join(await realpath(tmpdir()), 'nps-')),
    createDriver: createDriverExtension,
    prepareWorkspace: async (workspaceDir): Promise<void> => {
      await mkdir(workspaceDir, { recursive: true });
    },
    download: (version, cachePath) => downloadAndUnzipVSCode({ version, cachePath }),
    install: (vsixPath, version, cachePath, userDataDir, extensionsDir) => installPackagedVsix(
      vsixPath,
      version,
      cachePath,
      userDataDir,
      extensionsDir,
      process.platform,
    ),
    launch: (
      vscodeExecutablePath,
      driverDir,
      runnerPath,
      userDataDir,
      extensionsDir,
      workspaceDir,
    ) => runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: driverDir,
      extensionTestsPath: runnerPath,
      extensionTestsEnv: {
        ELECTRON_RUN_AS_NODE: undefined,
        NESTRO_PACKAGED_EXTENSIONS_DIR: extensionsDir,
      },
      launchArgs: [
        workspaceDir,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
      ],
    }),
    cleanup: root => removeFixturePath(root),
  };
}

export async function installPackagedVsix(
  vsixPath: string,
  version: '1.125.0' | 'stable',
  cachePath: string,
  userDataDir: string,
  extensionsDir: string,
  platform: string,
  runCommand: VSCodeCommandRunner = runVSCodeCommand,
): Promise<void> {
  await runCommand(
    buildVsixInstallArgs(vsixPath, userDataDir, extensionsDir, platform),
    { cachePath, reuseMachineInstall: true, version },
  );
}

export function assertSmokeSocketPathFits(userDataDir: string, platform: string): void {
  const limit = SOCKET_PATH_LIMITS[platform];
  if (limit === undefined) {
    return;
  }
  const projectedLength = userDataDir.length + 1 + SOCKET_FILE_NAME_LENGTH;
  if (projectedLength >= limit) {
    throw new Error(
      `packaged smoke user-data path projects to ${projectedLength} characters; ${platform} requires less than ${limit}`,
    );
  }
}

export function buildVsixInstallArgs(
  vsixPath: string,
  userDataDir: string,
  extensionsDir: string,
  platform: string,
): string[] {
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--install-extension',
    vsixPath,
    '--force',
  ];
  if (platform !== 'win32') {
    return args;
  }
  for (const arg of args) {
    if (arg.includes('\0') || arg.includes('\r') || arg.includes('\n') || arg.includes('"') || arg.includes('%')) {
      throw new Error('Windows packaged-smoke install paths must not contain NUL, CR, LF, double quote or percent');
    }
  }
  // test-electron 3.1.0 launches code.cmd with shell:true. Double quotes keep
  // spaces and cmd metacharacters such as & inside one controlled argument.
  return args.map(arg => `"${arg}"`);
}

/* v8 ignore start -- process bootstrap */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void runPackagedSmoke(parsePackagedSmokeArgs(process.argv.slice(2)), process.cwd())
    .catch((error: unknown) => {
      process.stderr.write(`Packaged smoke failed: ${describeError(error)}\n`);
      process.exitCode = 1;
    });
}
/* v8 ignore stop */