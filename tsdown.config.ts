import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/extension.ts'],
  outDir: 'dist',

  format: 'cjs',

  dts: false,

  sourcemap: true,

  clean: true,

  minify: false,

  external: [
    'vscode',
  ],
});