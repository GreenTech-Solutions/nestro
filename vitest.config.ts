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
				// Check every threshold per file; glob entries add checks to the global floor.
				perFile: true,
				// Global floor: weakest measured file per metric, rounded down.
				statements: 80,
				branches: 70,
				functions: 86,
				lines: 84,
				// Core pure-module floors use each module's measured level, rounded down.
				'src/utils/versionUtils.ts': { statements: 80, branches: 76, functions: 100, lines: 84 },
				'src/providers/treeBuilder.ts': { statements: 98, branches: 81, functions: 100, lines: 98 },
				'src/clients/**': { statements: 94, branches: 93, functions: 100, lines: 94 },
				// Other non-100% file floors use each file's measured level, rounded down.
				'src/utils/packageReader.ts': { statements: 86, branches: 70, functions: 90, lines: 87 },
				'src/utils/registryClient.ts': { statements: 93, branches: 85, functions: 100, lines: 93 },
				'src/utils/metadataRunner.ts': { statements: 96, branches: 88, functions: 100, lines: 96 },
				'src/utils/nativeMetadataClient.ts': { statements: 92, branches: 86, functions: 100, lines: 91 },
				'src/utils/bunConfig.ts': { statements: 92, branches: 90, functions: 100, lines: 92 },
				'src/utils/yarnMetadataClient.ts': { statements: 98, branches: 98, functions: 100, lines: 98 },
				'src/utils/ncuClient.ts': { statements: 85, branches: 80, functions: 100, lines: 84 },
				'src/utils/auditClient.ts': { statements: 100, branches: 92, functions: 100, lines: 100 },
				'src/utils/bunAuditClient.ts': { statements: 100, branches: 98, functions: 100, lines: 100 },
				'src/utils/yarnAuditClient.ts': { statements: 95, branches: 90, functions: 100, lines: 95 },
				'src/utils/yarnFamily.ts': { statements: 95, branches: 92, functions: 100, lines: 95 },
				'src/utils/logger.ts': { statements: 100, branches: 83, functions: 100, lines: 100 },
				// VSIX-tool floors use each file's clean-allowlist measurement, rounded down.
				'src/tools/vsixPolicy.ts': { statements: 98, branches: 97, functions: 100, lines: 98 },
				'src/tools/verifyVsix.ts': { statements: 100, branches: 98, functions: 100, lines: 100 },
				'src/tools/verifyVsixCli.ts': { statements: 100, branches: 94, functions: 100, lines: 100 },
				// Signature-audit files stay pinned at their measured 100% floors.
				'src/tools/auditSignatures.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
				'src/tools/auditSignaturesCli.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
				'src/tools/vsixArchive.ts': { statements: 100, branches: 98, functions: 100, lines: 100 },
				'src/tools/vsixManifest.ts': { statements: 96, branches: 92, functions: 100, lines: 96 },
				'src/providers/PackagesProvider.ts': { statements: 90, branches: 80, functions: 86, lines: 91 },
				'src/providers/FilterManager.ts': { statements: 98, branches: 84, functions: 94, lines: 98 },
				'src/providers/PackageItem.ts': { statements: 100, branches: 93, functions: 100, lines: 100 },
				'src/extension.ts': { statements: 97, branches: 90, functions: 94, lines: 100 },
				// Command glob floors use the weakest measured file per metric, rounded down.
				'src/commands/**': { statements: 99, branches: 88, functions: 100, lines: 98 },
				// Files already at 100% on every metric stay on the global floor.
			},
		},
	},
});
