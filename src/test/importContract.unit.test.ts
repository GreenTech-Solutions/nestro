import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = path.join(repoRoot, 'src');

/** Subsystem directories under `src/` that own a barrel. */
const SUBSYSTEMS = ['providers', 'utils', 'clients', 'commands', 'tools'] as const;
type Subsystem = typeof SUBSYSTEMS[number];

/**
 * Layer order: a subsystem may freely import a lower-ranked subsystem's barrel.
 * `tools` has no rank — it is fully isolated and checked separately (rule d).
 * `commands` and `extension.ts` sit above every ranked subsystem.
 */
const LAYER_RANK: Record<Exclude<Subsystem, 'tools'>, number> = {
  utils: 1,
  clients: 2,
  providers: 3,
  commands: 4,
};

/**
 * Documented exceptions to "cross-subsystem imports go through the barrel, downward only".
 * Each entry names the one file and the one import specifier it is allowed to use.
 */
interface AllowlistEntry {
  readonly file: string;
  readonly target: string;
  readonly reason: string;
}

const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    file: 'src/clients/ClientManager.ts',
    target: '../utils/logger',
    reason: 'clients never imports the utils barrel: it re-exports packageManager.ts, which imports ClientManager from clients, so routing through the barrel would recreate the clients-utils-clients cycle this rule exists to avoid.',
  },
  {
    file: 'src/clients/projectResolver.ts',
    target: '../utils/logger',
    reason: 'same barrel-cycle avoidance as ClientManager.ts.',
  },
  {
    file: 'src/clients/projectResolver.ts',
    target: '../utils/packageManagerKind',
    reason: 'same barrel-cycle avoidance as ClientManager.ts; PackageManager is defined in utils so clients and utils share one source of truth.',
  },
  {
    file: 'src/clients/NpmClient.ts',
    target: '../utils/auditClient',
    reason: 'same barrel-cycle avoidance as ClientManager.ts.',
  },
  {
    file: 'src/clients/PnpmClient.ts',
    target: '../utils/auditClient',
    reason: 'same barrel-cycle avoidance as ClientManager.ts.',
  },
  {
    file: 'src/clients/BunClient.ts',
    target: '../utils/auditClient',
    reason: 'same barrel-cycle avoidance as ClientManager.ts.',
  },
  {
    file: 'src/clients/BunClient.ts',
    target: '../utils/bunAuditClient',
    reason: 'same barrel-cycle avoidance as ClientManager.ts.',
  },
  {
    file: 'src/clients/YarnClient.ts',
    target: '../utils/auditClient',
    reason: 'same barrel-cycle avoidance as ClientManager.ts.',
  },
  {
    file: 'src/clients/YarnClient.ts',
    target: '../utils/yarnAuditClient',
    reason: 'same barrel-cycle avoidance as ClientManager.ts.',
  },
  {
    file: 'src/clients/Client.ts',
    target: '../utils/auditClient',
    reason: 'same barrel-cycle avoidance as ClientManager.ts.',
  },
  {
    file: 'src/clients/Client.ts',
    target: '../utils/shellTask',
    reason: 'same barrel-cycle avoidance as ClientManager.ts.',
  },
  {
    file: 'src/utils/packageManager.ts',
    target: '../clients',
    reason: 'detectPackageManager()/buildInstallCommand() only delegate to ClientManager; the module is documented and tested as part of utils, and relocating it to clients would ripple through every command/provider caller and test for no behavior change.',
  },
  {
    file: 'src/utils/auditReportFormatter.ts',
    target: '../providers',
    reason: 'AuditProjectFailure/AuditProjectSummary compose AuditProject (from clients) with utils audit primitives, so they can only be defined at the providers layer above both; the import is type-only and erased at compile time, so it carries no runtime cycle.',
  },
];

/** Every `import`/`export ... from '...'` module specifier in a source file. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*'([^']+)'/g,
    /\bimport\s*\(\s*'([^']+)'\s*\)/g,
    /\bimport\s+'([^']+)'/g,
  ];
  const specifiers: string[] = [];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function listTsFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listTsFiles(fullPath);
    }
    return entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function toRepoRelative(absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

/** Resolves a relative specifier against the importing file's directory, repo-root-relative. */
function resolveSpecifier(importingFile: string, specifier: string): string {
  const fileDir = path.dirname(importingFile);
  return path.posix.normalize(path.posix.join(fileDir.split(path.sep).join('/'), specifier));
}

/** The subsystem a repo-relative `src/...` path belongs to, or undefined outside `src/<subsystem>`. */
function subsystemOf(repoRelativePath: string): Subsystem | undefined {
  return SUBSYSTEMS.find(subsystem => repoRelativePath === `src/${subsystem}` || repoRelativePath.startsWith(`src/${subsystem}/`));
}

const allProductionFiles = listTsFiles(srcRoot)
  .map(toRepoRelative)
  .filter(file => !file.startsWith('src/test/'));

const allIndexFiles = listTsFiles(srcRoot)
  .map(toRepoRelative)
  .filter(file => file.endsWith('/index.ts'));

describe('import contract', () => {
  it('has no `export *` in any barrel', () => {
    const offenders = allIndexFiles.filter((file) => {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      return /\bexport\s*\*\s*from\b/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('never imports its own subsystem barrel, whether spelled `./index` or as the directory', () => {
    const offenders: string[] = [];
    for (const file of allProductionFiles) {
      const home = subsystemOf(file);
      if (home === undefined) {
        continue;
      }
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('.')) {
          continue;
        }
        const resolved = resolveSpecifier(file, specifier).replace(/\/index(\.ts)?$/, '');
        if (resolved === `src/${home}`) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps `tools` isolated from every other subsystem', () => {
    const offenders: string[] = [];
    for (const file of allProductionFiles.filter(f => subsystemOf(f) === 'tools')) {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('.')) {
          continue;
        }
        const target = subsystemOf(resolveSpecifier(file, specifier));
        if (target !== undefined && target !== 'tools') {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sends every cross-subsystem import through the target barrel, downward only, unless allowlisted', () => {
    const offenders: string[] = [];
    for (const file of allProductionFiles) {
      const home = subsystemOf(file);
      if (home === 'tools') {
        continue; // covered by the isolation test above
      }

      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('.')) {
          continue;
        }

        const resolved = resolveSpecifier(file, specifier);
        const target = subsystemOf(resolved);
        if (target === undefined || target === home) {
          continue; // not cross-subsystem
        }

        const isExactBarrel = resolved === `src/${target}`;
        const targetRank = target === 'tools' ? undefined : LAYER_RANK[target];
        const homeRank = home === undefined ? undefined : LAYER_RANK[home];
        // `extension.ts` (home undefined) sits above every ranked subsystem but never reaches
        // `tools`; a ranked home also needs the target strictly beneath it.
        const isAllowedDirection = targetRank !== undefined
          && (home === undefined || (homeRank !== undefined && targetRank < homeRank));

        if (isExactBarrel && isAllowedDirection) {
          continue;
        }

        const allowed = ALLOWLIST.some(entry => entry.file === file && entry.target === specifier);
        if (!allowed) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every allowlist entry pointing at a real, still-present import', () => {
    const offenders: string[] = [];
    for (const entry of ALLOWLIST) {
      const absolutePath = path.join(repoRoot, entry.file);
      let source: string;
      try {
        source = readFileSync(absolutePath, 'utf8');
      }
      catch {
        offenders.push(`${entry.file}: file does not exist`);
        continue;
      }
      if (!importSpecifiers(source).includes(entry.target)) {
        offenders.push(`${entry.file}: no import of '${entry.target}' found`);
      }
    }
    expect(offenders).toEqual([]);
  });
});