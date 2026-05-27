# Caliber Learnings

Accumulated patterns and anti-patterns from development sessions.
Auto-managed by [caliber](https://github.com/caliber-ai-org/ai-setup) — do not edit manually.

- **[fix:project]** `tsdown.config.ts` (`.ts` extension) silently fails to load when the file uses ESM `import` syntax — rename to `tsdown.config.mts` so tsdown picks it up. First symptom is `pnpm exec tsdown` hanging or returning empty output.
- **[gotcha:project]** tsdown with `format: 'cjs'` emits `out/extension.cjs`, but VS Code loads the file named in `package.json` `"main"`. If `main` still says `./out/extension.js`, activation fails with "Cannot find module". Always keep `main` in sync with tsdown's actual output extension.
- **[pattern:project]** `vscode:prepublish` must run `pnpm run build` (tsdown), not `pnpm run compile` (tsc). The `compile`/`watch` tsc scripts are only for compiling integration tests to `out/test/`; they do NOT produce the bundled extension entry point.
- **[pattern:project]** For tsdown watch mode in `.vscode/tasks.json`, use a custom background `problemMatcher` with `beginsPattern: "Build start"` and `endsPattern: "Build complete|Rebuilt in"` — this is how VS Code detects when a tsdown rebuild finishes and can reload the extension host for F5 hot-reload.
- **[gotcha:project]** `tsconfig.json` uses `"module": "esnext"` + `"moduleResolution": "bundler"` for tsdown — do not change it. Integration tests require a separate `tsconfig.test.json` with `"module": "Node16"` + `"moduleResolution": "Node16"`. Using `"module": "commonjs"` in tsconfig.test.json fails with tsc; `Node16` is the correct value.
- **[fix:project]** Vitest `vi.fn<>()` accepts only one type argument (the function signature), e.g. `vi.fn<() => void>()`. The two-argument form `vi.fn<[string, ...unknown[]], void>()` gives TS2558 "Expected 0-1 type arguments".
- **[gotcha:project]** Unit test files in `src/test/` import source modules as `'../extension'` (one level up), not `'../../extension'`. The source root is `src/`, so relative imports go up one directory from `src/test/`.
- **[pattern:project]** When installing `semantic-release-vsce` with pnpm, add `"pnpm": { "onlyBuiltDependencies": ["@vscode/vsce-sign", "keytar"] }` to `package.json` to allow native dependency builds required by vsce.
- **[env:project]** `pnpm add` for large dependency sets (semantic-release and plugins) can time out in Claude's Bash tool even though the install actually completes in the background. Check `package.json` devDependencies after a timeout before retrying the install.
