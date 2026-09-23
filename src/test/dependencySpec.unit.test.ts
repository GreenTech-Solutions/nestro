import { describe, expect, it } from 'vitest';
import { formatDependencySpec, parseDependencySpec } from '../utils';
import type { PinnableDependencySpec } from '../utils';

describe('parseDependencySpec() — supported specs', () => {
  it.each([
    ['18.0.0', 'plain', 'exact', '18.0.0'],
    ['^18.0.0', 'plain', 'caret', '18.0.0'],
    ['~18.0.0', 'plain', 'tilde', '18.0.0'],
    ['1.2.3-beta.1', 'plain', 'exact', '1.2.3-beta.1'],
    ['1.2.3-x.7.z.92', 'plain', 'exact', '1.2.3-x.7.z.92'],
    ['1.2.3+build.5', 'plain', 'exact', '1.2.3+build.5'],
    ['1.0.0+build.x', 'plain', 'exact', '1.0.0+build.x'],
    ['^1.2.3-beta.1+build.5', 'plain', 'caret', '1.2.3-beta.1+build.5'],
    ['~1.2.3-beta.1+meta', 'plain', 'tilde', '1.2.3-beta.1+meta'],
    ['workspace:1.2.3', 'workspace', 'exact', '1.2.3'],
    ['workspace:^1.2.3', 'workspace', 'caret', '1.2.3'],
    ['workspace:^1.2.3-rc.1', 'workspace', 'caret', '1.2.3-rc.1'],
    ['workspace:~2.3.4', 'workspace', 'tilde', '2.3.4'],
  ] as const)('parses %s as %s/%s/%s', (spec, protocol, range, version) => {
    const parsed = parseDependencySpec(spec);
    expect(parsed).toEqual({ supported: true, protocol, range, version });
  });
});

describe('parseDependencySpec() — unsupported specs', () => {
  it.each([
    ['', 'empty version spec'],
    ['npm:real-pkg@^1.2.3', 'npm alias dependency'],
    ['git+https://github.com/foo/bar.git', 'git dependency'],
    ['git+ssh://git@github.com/foo/bar.git', 'git dependency'],
    ['git://github.com/foo/bar.git', 'git dependency'],
    ['ssh://git@github.com/foo/bar.git', 'git dependency'],
    ['git@github.com:foo/bar.git', 'git dependency'],
    ['https://github.com/foo/bar.git', 'git dependency'],
    ['github:foo/bar', 'git dependency'],
    ['gitlab:foo/bar', 'git dependency'],
    ['bitbucket:foo/bar', 'git dependency'],
    ['foo/bar', 'git dependency'],
    ['foo/bar#v1.2.3', 'git dependency'],
    ['file:../local-pkg', 'local file dependency'],
    ['file:./local-pkg.tgz', 'local file dependency'],
    ['https://example.com/pkg-1.0.0.tgz', 'remote tarball dependency'],
    ['>=1.2.3 <2.0.0', 'compound version range'],
    ['1.2.3 || 2.0.0', 'compound version range'],
    ['*', 'wildcard version range'],
    ['X.2.3', 'wildcard version range'],
    ['1.X.3', 'wildcard version range'],
    ['1.x', 'wildcard version range'],
    ['1.2.x', 'wildcard version range'],
    ['>=1.2.3', 'comparator version range'],
    ['>1.2.3', 'comparator version range'],
    ['<=1.2.3', 'comparator version range'],
    ['<1.2.3', 'comparator version range'],
    ['=1.2.3', 'comparator version range'],
    ['^1.2', 'partial version range'],
    ['~1', 'partial version range'],
    ['latest', 'dist-tag reference'],
    ['Latest', 'dist-tag reference'],
    ['next', 'dist-tag reference'],
    [' 1.2.3 ', 'whitespace in version spec'],
    ['01.2.3', 'unrecognized version spec'],
    ['1.2.03', 'unrecognized version spec'],
    ['1.2.3-01', 'unrecognized version spec'],
    ['1.2.3-', 'unrecognized version spec'],
    ['1.2.3+build..x', 'unrecognized version spec'],
    ['!invalid', 'unrecognized version spec'],
  ] as const)('reports %s as unsupported: %s', (spec, reason) => {
    const parsed = parseDependencySpec(spec);
    expect(parsed).toEqual({ supported: false, reason });
  });

  it.each([
    ['workspace:*', 'workspace range is not a concrete version (wildcard version range)'],
    ['workspace:^', 'workspace range is not a concrete version (partial version range)'],
    ['workspace:~', 'workspace range is not a concrete version (partial version range)'],
    ['workspace:', 'workspace range is not a concrete version (empty version spec)'],
    ['workspace:latest', 'workspace range is not a concrete version (dist-tag reference)'],
  ] as const)('reports non-concrete workspace range %s as unsupported: %s', (spec, reason) => {
    const parsed = parseDependencySpec(spec);
    expect(parsed).toEqual({ supported: false, reason });
  });
});

describe('formatDependencySpec()', () => {
  const cases: [PinnableDependencySpec, boolean, string][] = [
    [{ supported: true, protocol: 'plain', range: 'caret', version: '1.2.3' }, true, '1.2.3'],
    [{ supported: true, protocol: 'plain', range: 'exact', version: '1.2.3' }, false, '^1.2.3'],
    [{ supported: true, protocol: 'workspace', range: 'caret', version: '1.2.3' }, true, 'workspace:1.2.3'],
    [{ supported: true, protocol: 'workspace', range: 'exact', version: '1.2.3' }, false, 'workspace:^1.2.3'],
    [{ supported: true, protocol: 'workspace', range: 'tilde', version: '1.2.3-beta.1+meta' }, true, 'workspace:1.2.3-beta.1+meta'],
  ];

  it.each(cases)('formats %o with pin=%s as %s', (spec, pin, expected) => {
    expect(formatDependencySpec(spec, pin)).toBe(expected);
  });
});