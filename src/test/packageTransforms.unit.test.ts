import { describe, expect, it } from 'vitest';
import {
  DependencyTypeConflictError,
  parsePackageJson,
  prepareDependencyType,
  prepareDependencyVersions,
  preparePinAllVersions,
  prepareVersionPin,
  serializePackageJson,
  transformDependencyType,
  transformDependencyVersions,
  transformPinAllVersions,
  transformVersionPin,
  VersionPinConflictError,
} from '../utils';
import type { PackageJsonDocument } from '../utils';

describe('parsePackageJson()', () => {
  it('parses a package.json document into a plain object', () => {
    expect(parsePackageJson('{"name":"pkg","dependencies":{"react":"^18.0.0"}}')).toEqual({
      name: 'pkg',
      dependencies: { react: '^18.0.0' },
    });
  });
});

describe('serializePackageJson()', () => {
  const json: PackageJsonDocument = { dependencies: { react: '^18.0.0' } };

  it('preserves 2-space indentation', () => {
    const raw = JSON.stringify(json, undefined, 2);
    expect(serializePackageJson(raw, json)).toBe(`${JSON.stringify(json, undefined, 2)}`);
  });

  it('preserves 4-space indentation', () => {
    const raw = JSON.stringify(json, undefined, 4);
    expect(serializePackageJson(raw, json)).toBe(`${JSON.stringify(json, undefined, 4)}`);
  });

  it('preserves tab indentation', () => {
    const raw = JSON.stringify(json, undefined, '\t');
    expect(serializePackageJson(raw, json)).toBe(`${JSON.stringify(json, undefined, '\t')}`);
  });

  it('keeps a trailing newline when the original has one', () => {
    const raw = `${JSON.stringify(json, undefined, 2)}\n`;
    expect(serializePackageJson(raw, json).endsWith('\n')).toBe(true);
  });

  it('preserves CRLF line endings and a trailing CRLF', () => {
    const raw = `${JSON.stringify(json, undefined, 2).replace(/\n/g, '\r\n')}\r\n`;
    const updatedJson: PackageJsonDocument = { dependencies: { react: '^19.0.0' } };
    const serialized = serializePackageJson(raw, json);
    const expected = `${JSON.stringify(updatedJson, undefined, 2).replace(/\n/g, '\r\n')}\r\n`;

    expect(serializePackageJson(raw, updatedJson)).toBe(expected);
    expect(serialized.replace(/\r\n/g, '')).not.toContain('\n');
    expect(serialized.match(/\r\n/g)?.length).toBeGreaterThan(0);
  });

  it('omits a trailing newline when the original has none', () => {
    const raw = JSON.stringify(json, undefined, 2);
    expect(serializePackageJson(raw, json).endsWith('\n')).toBe(false);
  });

  it('falls back to 2-space indentation when the original has no detectable indent', () => {
    const raw = JSON.stringify(json);
    expect(serializePackageJson(raw, json)).toBe(JSON.stringify(json, undefined, 2));
  });
});

describe('transformDependencyVersions()', () => {
  it('updates the version while preserving the existing prefix', () => {
    const json: PackageJsonDocument = { dependencies: { react: '^17.0.0' } };
    const result = transformDependencyVersions(json, [
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]);
    expect(result).toEqual({ dependencies: { react: '^18.0.0' } });
  });

  it('updates only the requested section when the name exists in both', () => {
    const json: PackageJsonDocument = {
      dependencies: { typescript: '^4.0.0' },
      devDependencies: { typescript: '~5.0.0' },
    };
    const result = transformDependencyVersions(json, [
      { name: 'typescript', version: '5.9.3', section: 'devDependencies' },
    ]);
    expect(result).toEqual({
      dependencies: { typescript: '^4.0.0' },
      devDependencies: { typescript: '~5.9.3' },
    });
  });

  it('throws listing every missing package and section', () => {
    const json: PackageJsonDocument = { dependencies: { react: '^17.0.0' } };
    expect(() => transformDependencyVersions(json, [
      { name: 'vue', version: '3.0.0', section: 'dependencies' },
      { name: 'vite', version: '5.0.0', section: 'devDependencies' },
    ])).toThrow('Packages not found in package.json: vue (dependencies), vite (devDependencies)');
  });

  it('does not mutate the input document', () => {
    const json: PackageJsonDocument = { dependencies: { react: '^17.0.0' } };
    transformDependencyVersions(json, [{ name: 'react', version: '18.0.0', section: 'dependencies' }]);
    expect(json).toEqual({ dependencies: { react: '^17.0.0' } });
  });
});

describe('transformDependencyType()', () => {
  it('moves a package from dependencies to devDependencies, preserving its version', () => {
    const json: PackageJsonDocument = {
      dependencies: { zod: '^3.0.0' },
      devDependencies: { axios: '^1.0.0' },
    };
    const result = transformDependencyType(json, 'zod', false, '^3.0.0');
    expect(result).toEqual({
      devDependencies: { axios: '^1.0.0', zod: '^3.0.0' },
    });
  });

  it('drops the source section entirely once it becomes empty', () => {
    const json: PackageJsonDocument = { dependencies: { zod: '^3.0.0' } };
    const result = transformDependencyType(json, 'zod', false, '^3.0.0');
    expect(result).toEqual({ devDependencies: { zod: '^3.0.0' } });
    expect(Object.hasOwn(result, 'dependencies')).toBe(false);
  });

  it('throws a typed conflict when the source spec changed', () => {
    const json: PackageJsonDocument = { dependencies: { pkg: '~2.0.0' } };
    expect(() => transformDependencyType(json, 'pkg', false, '^1.2.3'))
      .toThrow('source spec changed from ^1.2.3 to ~2.0.0');
  });

  it('throws a typed conflict when the target already has the package', () => {
    const json: PackageJsonDocument = {
      dependencies: { pkg: '^1.2.3' },
      devDependencies: { pkg: '~2.0.0' },
    };
    let error: unknown;
    try {
      transformDependencyType(json, 'pkg', false, '^1.2.3');
    }
    catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(DependencyTypeConflictError);
    expect((error as DependencyTypeConflictError).hasTargetSpec).toBe(true);
  });

  it('switches an own "constructor" entry when the target only inherits that key', () => {
    const dependencies = { other: '^2.0.0' } as Record<string, string>;
    Object.defineProperty(dependencies, 'constructor', {
      configurable: true,
      enumerable: true,
      value: '^1.0.0',
      writable: true,
    });
    const json: PackageJsonDocument = { dependencies, devDependencies: { zod: '^3.0.0' } };

    const result = transformDependencyType(json, 'constructor', false, '^1.0.0');

    expect(result.dependencies).toEqual({ other: '^2.0.0' });
    const devDependencies = result.devDependencies as Record<string, unknown>;
    expect(Object.hasOwn(devDependencies, 'constructor')).toBe(true);
    expect(devDependencies.constructor).toBe('^1.0.0');
  });

  it('does not mutate the input document', () => {
    const json: PackageJsonDocument = { dependencies: { zod: '^3.0.0' } };
    transformDependencyType(json, 'zod', false, '^3.0.0');
    expect(json).toEqual({ dependencies: { zod: '^3.0.0' } });
  });
});

describe('transformVersionPin()', () => {
  it('removes the prefix when pinning', () => {
    const json: PackageJsonDocument = { dependencies: { react: '^18.0.0' } };
    const result = transformVersionPin(json, 'react', 'dependencies', '^18.0.0', true);
    expect(result).toEqual({ dependencies: { react: '18.0.0' } });
  });

  it('restores a caret when unpinning', () => {
    const json: PackageJsonDocument = { dependencies: { react: '18.0.0' } };
    const result = transformVersionPin(json, 'react', 'dependencies', '18.0.0', false);
    expect(result).toEqual({ dependencies: { react: '^18.0.0' } });
  });

  it('preserves the workspace: protocol', () => {
    const json: PackageJsonDocument = { dependencies: { internal: 'workspace:^1.2.3' } };
    const result = transformVersionPin(json, 'internal', 'dependencies', 'workspace:^1.2.3', true);
    expect(result).toEqual({ dependencies: { internal: 'workspace:1.2.3' } });
  });

  it('throws a version pin conflict when the spec no longer matches', () => {
    const json: PackageJsonDocument = { dependencies: { react: '^18.1.0' } };
    expect(() => transformVersionPin(json, 'react', 'dependencies', '^18.0.0', true))
      .toThrow(VersionPinConflictError);
  });

  it('throws for an unsupported spec', () => {
    const json: PackageJsonDocument = { dependencies: { pkg: 'latest' } };
    expect(() => transformVersionPin(json, 'pkg', 'dependencies', 'latest', true))
      .toThrow('Cannot toggle pin for pkg: dist-tag reference.');
  });

  it('does not mutate the input document', () => {
    const json: PackageJsonDocument = { dependencies: { react: '^18.0.0' } };
    transformVersionPin(json, 'react', 'dependencies', '^18.0.0', true);
    expect(json).toEqual({ dependencies: { react: '^18.0.0' } });
  });
});

describe('transformPinAllVersions()', () => {
  it('pins every pinnable range across both sections', () => {
    const json: PackageJsonDocument = {
      dependencies: { react: '^18.0.0' },
      devDependencies: { vite: '~5.0.0' },
    };
    const result = transformPinAllVersions(json);
    expect(result).toEqual({
      count: 2,
      json: {
        dependencies: { react: '18.0.0' },
        devDependencies: { vite: '5.0.0' },
      },
    });
  });

  it('skips unsupported specs without counting them', () => {
    const json: PackageJsonDocument = { dependencies: { alias: 'npm:real-pkg@^1.2.3', exact: '1.2.3' } };
    const result = transformPinAllVersions(json);
    expect(result.count).toBe(0);
    expect(result.json).toEqual(json);
  });

  it('treats a null dependencies section as empty instead of throwing', () => {
    const json: PackageJsonDocument = { dependencies: null, devDependencies: { react: '^1.0.0' } };
    const result = transformPinAllVersions(json);
    expect(result.count).toBe(1);
  });

  it('does not mutate the input document', () => {
    const json: PackageJsonDocument = { dependencies: { react: '^18.0.0' } };
    transformPinAllVersions(json);
    expect(json).toEqual({ dependencies: { react: '^18.0.0' } });
  });
});

describe('prepareDependencyVersions() / prepareDependencyType() / prepareVersionPin() / preparePinAllVersions()', () => {
  it('round-trips a raw document through parse, transform and serialize, preserving tabs', () => {
    const raw = JSON.stringify({ dependencies: { react: '^17.0.0' } }, undefined, '\t');
    const updated = prepareDependencyVersions(raw, [{ name: 'react', version: '18.0.0', section: 'dependencies' }]);
    expect(updated).toBe(JSON.stringify({ dependencies: { react: '^18.0.0' } }, undefined, '\t'));
  });

  it('preserves a trailing newline while switching dependency type', () => {
    const raw = `${JSON.stringify({ dependencies: { zod: '^3.0.0' } }, undefined, 2)}\n`;
    const updated = prepareDependencyType(raw, 'zod', false, '^3.0.0');
    expect(updated.endsWith('\n')).toBe(true);
    expect(JSON.parse(updated)).toEqual({ devDependencies: { zod: '^3.0.0' } });
  });

  it('serializes a pinned version without a trailing newline when the original had none', () => {
    const raw = JSON.stringify({ dependencies: { react: '^18.0.0' } }, undefined, 2);
    const updated = prepareVersionPin(raw, 'react', 'dependencies', '^18.0.0', true);
    expect(updated.endsWith('\n')).toBe(false);
    expect(JSON.parse(updated)).toEqual({ dependencies: { react: '18.0.0' } });
  });

  it('reports count 0 and leaves the document untouched when nothing needs pinning', () => {
    const raw = JSON.stringify({ dependencies: { react: '18.0.0' } }, undefined, 2);
    const result = preparePinAllVersions(raw);
    expect(result).toEqual({ count: 0, updated: undefined });
  });

  it('serializes the pinned document with 4-space indentation when pinning is needed', () => {
    const raw = JSON.stringify({ dependencies: { react: '^18.0.0' } }, undefined, 4);
    const result = preparePinAllVersions(raw);
    expect(result.count).toBe(1);
    expect(result.updated).toBe(JSON.stringify({ dependencies: { react: '18.0.0' } }, undefined, 4));
  });
});