import { normalizeArtifactOutDir } from './verifyVsix';
import { writeCiEvidence } from './ciEvidence';

export function parseCiEvidenceArgs(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--out-dir') {
    throw new Error('usage: ci:evidence --out-dir <relative-directory>');
  }
  return normalizeArtifactOutDir(argv[1]);
}

export async function mainCiEvidence(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const evidence = await writeCiEvidence(cwd, parseCiEvidenceArgs(argv), {
      sourceSha: env.CI_SOURCE_SHA,
      runId: env.CI_RUN_ID,
      runAttempt: env.CI_RUN_ATTEMPT,
      eventName: env.CI_EVENT_NAME,
      pullRequestHeadSha: env.CI_PR_HEAD_SHA || undefined,
    });
    process.stdout.write(`Evidence recorded for ${evidence.sourceSha}: releaseEligible=false\n`);
    return 0;
  }
  catch (error) {
    process.stderr.write(`CI evidence failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/* v8 ignore start -- process bootstrap */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void mainCiEvidence(process.argv.slice(2), process.cwd(), process.env).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
/* v8 ignore stop */