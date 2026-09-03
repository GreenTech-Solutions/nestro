import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	resolve: {
		alias: {
			vscode: path.resolve('./src/test/__mocks__/vscode.ts'),
		},
	},
	test: {
		include: ['src/**/*.unit.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/test/**'],
			reporter: ['text', 'lcov'],
			thresholds: {
				// perFile is a single global switch: every threshold set below (global and
				// per-glob alike) is checked per file, not as a folder aggregate. Vitest
				// 4.1.10 has no per-glob perFile override (see AUD-03 implementer report for
				// the vitest source citation).
				perFile: true,
				// The global set below is checked against every included file, even a file
				// that also matches one of the glob entries further down — matching a glob
				// adds a stricter check on top, it never exempts a file from this floor. So
				// this floor can never be set higher than the single weakest file in the
				// whole `src/**/*.ts` population (see AUD-03 fix pass 1 — this is why a
				// per-glob override for packageReader.ts alone could not be used to raise
				// this floor above 70).
				// Global floor = the weakest currently-passing file for each metric, rounded
				// down to the nearest integer (measured on refactoring, see AUD-03 report):
				//   statements 80.82% (versionUtils.ts) -> 80
				//   branches   70.88% (packageReader.ts) -> 70
				//   functions  86.79% (PackagesProvider.ts) -> 86
				//   lines      84.61% (ncuClient.ts) -> 84
				statements: 80,
				branches: 70,
				functions: 86,
				lines: 84,
				// Core pure modules get their own higher floor so a regression there can't
				// hide behind the more lenient global floor above. Numbers are each module's
				// own measured level, rounded down.
				'src/utils/versionUtils.ts': { statements: 80, branches: 76, functions: 100, lines: 84 },
				'src/providers/treeBuilder.ts': { statements: 98, branches: 81, functions: 100, lines: 98 },
				'src/clients/**': { statements: 94, branches: 93, functions: 100, lines: 94 },
				// Every other file that isn't already at 100% on every metric also gets its
				// own floor so a regression can't hide behind the wide branches gap between
				// the global floor (70, set by packageReader.ts) and everyone else — branches
				// is the card's priority metric and must stay tight per file. Numbers are
				// each file's own measured level, rounded down (AUD-03 fix pass 1).
				'src/utils/packageReader.ts': { statements: 86, branches: 70, functions: 90, lines: 87 },
				'src/utils/registryClient.ts': { statements: 93, branches: 85, functions: 100, lines: 93 },
				'src/utils/metadataRunner.ts': { statements: 96, branches: 88, functions: 100, lines: 96 },
				'src/utils/nativeMetadataClient.ts': { statements: 92, branches: 86, functions: 100, lines: 91 },
				'src/utils/ncuClient.ts': { statements: 85, branches: 80, functions: 100, lines: 84 },
				'src/utils/auditClient.ts': { statements: 100, branches: 92, functions: 100, lines: 100 },
				'src/utils/bunAuditClient.ts': { statements: 100, branches: 98, functions: 100, lines: 100 },
				// AUD-05B: measured after the full Yarn family/schema matrix. Rounded-down
				// per-file floors keep new family/parser regressions visible without pinning
				// the non-trivial branch surfaces to vanity 100% targets.
				'src/utils/yarnAuditClient.ts': { statements: 95, branches: 90, functions: 100, lines: 95 },
				'src/utils/yarnFamily.ts': { statements: 95, branches: 92, functions: 100, lines: 95 },
				'src/utils/logger.ts': { statements: 100, branches: 83, functions: 100, lines: 100 },
				// AUD-12: the VSIX package boundary tooling. Numbers are each file's own
				// measured level on the clean allowlist package, rounded down.
				// src/tools/index.ts measures 100% on all four metrics, so — same rule as
				// the barrels further down — it intentionally gets no entry and stays on the
				// global backstop rather than being pinned to a vanity 100 on every metric.
				// The ZIP and XML readers have deliberately broad fail-closed grammars, so
				// their measured rounded floors are recorded separately.
				'src/tools/vsixPolicy.ts': { statements: 98, branches: 97, functions: 100, lines: 98 },
				'src/tools/verifyVsix.ts': { statements: 100, branches: 98, functions: 100, lines: 100 },
				'src/tools/verifyVsixCli.ts': { statements: 100, branches: 94, functions: 100, lines: 100 },
				// AUD-11: the pnpm signature audit guard. Measured at 100% on all four
				// metrics for both files, and pinned there as a deliberate, narrow
				// exception to the "files at 100% everywhere get no entry" rule stated at
				// the end of this block. That rule exists so unrelated churn in a tiny
				// TreeItem class or a barrel cannot hard-fail the gate; neither file here
				// is that. Their whole content is one closed decision surface — every
				// branch is one member of the SignatureAuditRejectionReason union — so a
				// new untested branch means a new, unproven way for a supply-chain gate to
				// answer, which is exactly the "green proves nothing" defect AUD-11 closes.
				// Leaving them on the global backstop (branches 70) would allow that.
				// The negative-threshold form AUD-03's review left as a fast-follow
				// (`branches: -2` = at most N uncovered units) was considered and does not
				// fit here for the same reason: the smallest useful negative value still
				// permits one uncovered branch, and one uncovered branch in this file is
				// one untested answer from the signature gate. Where the anti-vanity rule
				// protects files whose new branches are ordinary code, these two have no
				// ordinary branches to protect.
				'src/tools/auditSignatures.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
				'src/tools/auditSignaturesCli.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
				'src/tools/vsixArchive.ts': { statements: 100, branches: 98, functions: 100, lines: 100 },
				'src/tools/vsixManifest.ts': { statements: 96, branches: 92, functions: 100, lines: 96 },
				'src/providers/PackagesProvider.ts': { statements: 90, branches: 80, functions: 86, lines: 91 },
				'src/providers/FilterManager.ts': { statements: 98, branches: 84, functions: 94, lines: 98 },
				'src/providers/PackageItem.ts': { statements: 100, branches: 93, functions: 100, lines: 100 },
				'src/extension.ts': { statements: 97, branches: 90, functions: 94, lines: 100 },
				// Weakest individual file within the glob (perFile:true — not the folder
				// aggregate), same approach as src/clients/** above: removePackage.ts sets
				// the branches floor, installUpdate.ts sets statements/lines; the remaining
				// command files (pickVersion.ts, pinAllVersions.ts, pinVersion.ts,
				// switchDepType.ts) are at 100% and clear this floor with margin.
				'src/commands/**': { statements: 99, branches: 88, functions: 100, lines: 98 },
				// Files at 100% on all four metrics (shellTask.ts, pickVersion.ts, notify.ts,
				// packageManager.ts, barrels, tiny TreeItem classes) intentionally get no
				// glob entry of their own: pinning every metric at 100 is the vanity pattern
				// the card forbids (the same reason `100: true` is banned) — the first
				// legitimately-new untested branch in one of them would hard-fail the gate for
				// a change unrelated to a real coverage regression. They stay covered by the
				// global backstop above.
			},
		},
	},
});
