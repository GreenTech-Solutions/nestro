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
				perFile: true,
				// Global floors use the weakest measured file per metric, rounded down.
				statements: 85,
				branches: 75,
				functions: 87,
				lines: 84,
				// Area floors use the weakest file in each area per metric, rounded down.
				'src/clients/**': { statements: 97, branches: 94, functions: 100, lines: 97, perFile: true },
				'src/commands/**': { statements: 100, branches: 93, functions: 100, lines: 100, perFile: true },
				'src/config/**': { statements: 100, branches: 100, functions: 100, lines: 100, perFile: true },
				'src/shared/**': { statements: 97, branches: 90, functions: 100, lines: 97, perFile: true },
				'src/providers/**': { statements: 89, branches: 78, functions: 94, lines: 88, perFile: true },
				'src/tools/**': { statements: 90, branches: 85, functions: 87, lines: 90, perFile: true },
				'src/utils/**': { statements: 88, branches: 81, functions: 90, lines: 88, perFile: true },
				'src/extension.ts': { statements: 97, branches: 94, functions: 94, lines: 100, perFile: true },
				// Tool gates keep all four metrics at 100% for every matching file.
				'src/tools/audit*.ts': { statements: 100, branches: 100, functions: 100, lines: 100, perFile: true },
				'src/tools/verifyVsix*.ts': { statements: 100, branches: 100, functions: 100, lines: 100, perFile: true },
				'src/tools/ciPolicy.ts': { statements: 100, branches: 100, functions: 100, lines: 100, perFile: true },
			},
		},
	},
});