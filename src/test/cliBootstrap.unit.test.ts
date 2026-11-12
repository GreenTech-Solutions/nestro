import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCliAsEntry } from '../tools/cliBootstrap';

const entry = { id: 'entry' } as unknown as NodeJS.Module;
const other = { id: 'other' } as unknown as NodeJS.Module;

describe('runCliAsEntry()', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('runs the CLI and publishes its exit code when the module started node', async () => {
    const run = vi.fn(() => Promise.resolve(3));

    runCliAsEntry(entry, run, entry);
    await vi.waitFor(() => expect(process.exitCode).toBe(3));

    expect(run).toHaveBeenCalledOnce();
  });

  it('does nothing when another module started node', () => {
    const run = vi.fn(() => Promise.resolve(3));

    runCliAsEntry(entry, run, other);

    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing when the module or the started module is unknown', () => {
    const run = vi.fn(() => Promise.resolve(3));

    let unknown: NodeJS.Module | undefined;

    runCliAsEntry(unknown, run, entry);
    runCliAsEntry(entry, run, unknown);

    expect(run).not.toHaveBeenCalled();
  });

  it('defaults the started module to the process entry module', () => {
    const run = vi.fn(() => Promise.resolve(0));

    runCliAsEntry(entry, run);

    expect(run).not.toHaveBeenCalled();
  });
});