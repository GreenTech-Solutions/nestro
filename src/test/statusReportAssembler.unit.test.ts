import { describe, expect, it } from 'vitest';
import {
  createPackageReadFailureSnapshot,
  createStatusReportSnapshot,
  createUpdateFailureSnapshot,
} from '../providers/statusReportAssembler';

describe('status report assembly', () => {
  it('groups package read details by manifest and includes discovery failures', () => {
    expect(createPackageReadFailureSnapshot(
      ['/workspace/a/package.json'],
      [
        { packageFilePath: '/workspace/a/package.json', error: 'bad json' },
        { packageFilePath: '/workspace/a/package.json', error: 'read failed' },
      ],
      true,
    )).toEqual([
      {
        packageFilePaths: ['/workspace/a/package.json'],
        reason: 'package-read-failed',
        detail: 'bad json; read failed',
      },
      {
        packageFilePaths: [],
        reason: 'package-discovery-failed',
        detail: 'Failed to discover workspace package files.',
      },
    ]);
  });

  it('retains every attempted update path and formats thrown errors', () => {
    expect(createUpdateFailureSnapshot(
      ['/workspace/a/package.json', '/workspace/b/package.json'],
      [{ packageFilePath: '/workspace/a/package.json', error: new Error('network error') }],
    )).toEqual([
      expect.objectContaining({
        packageFilePaths: ['/workspace/a/package.json'],
        reason: 'update-check-failed',
        detail: expect.stringContaining('network error'),
      }),
      {
        packageFilePaths: ['/workspace/b/package.json'],
        reason: 'update-check-failed',
      },
    ]);
  });

  it('returns copied failures and fills audit paths from their project manifests', () => {
    const packageReadFailures = [{ packageFilePaths: ['/workspace/a/package.json'], reason: 'read' }];
    const snapshot = createStatusReportSnapshot({
      packageReadFailures,
      updateFailures: [],
      auditFailures: [{
        project: {
          projectRoot: '/workspace',
          workspaceFolder: '/workspace',
          packageManager: 'npm',
          lockfilePath: '/workspace/package-lock.json',
          originManifests: ['/workspace/b/package.json'],
        },
        packageFilePaths: [],
        reason: 'audit',
        detail: 'failed',
      }],
      workspaceFolderDescriptors: [],
    });

    packageReadFailures[0].packageFilePaths.push('/workspace/changed/package.json');
    expect(snapshot.packageReadFailures[0]?.packageFilePaths).toEqual(['/workspace/a/package.json']);
    expect(snapshot.auditFailures[0]?.packageFilePaths).toEqual(['/workspace/b/package.json']);
  });
});