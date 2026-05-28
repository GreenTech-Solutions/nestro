import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/extension.ts'],
  outDir: 'out',

  format: 'cjs',

  dts: false,

  platform: 'node',

  target: 'node20',

  sourcemap: true,

  clean: true,

  minify: false,

  deps: {
    neverBundle: [
      'vscode',
    ],
    alwaysBundle: [
      'npm-check-updates',
    ],
  }
});
