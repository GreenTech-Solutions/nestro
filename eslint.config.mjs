import stylistic from '@stylistic/eslint-plugin';
import gitignore from 'eslint-config-flat-gitignore';
import sonarjs from 'eslint-plugin-sonarjs';
import typescriptEslint from 'typescript-eslint';

// Files that predate the size limits, each at its current measured size; a ceiling only goes down.
// maxLines caps the file, maxFunctionLines caps its longest function; delete a key once the file fits the default.
const SIZE_LIMIT_EXCEPTIONS = {
  'src/commands/installUpdate.ts': { maxLines: 588, maxFunctionLines: 96 },
  'src/commands/pickVersion.ts': { maxFunctionLines: 110 },
  'src/commands/removePackage.ts': { maxFunctionLines: 62 },
  'src/extension.ts': { maxFunctionLines: 64 },
  'src/providers/PackageItem.ts': { maxFunctionLines: 88 },
  'src/providers/PackagesProvider.ts': { maxLines: 1519, maxFunctionLines: 168 },
  'src/providers/packageIdentity.ts': { maxFunctionLines: 80 },
  'src/providers/packageLoadingService.ts': { maxFunctionLines: 77 },
  'src/providers/treeBuilder.ts': { maxLines: 626 },
  'src/providers/updateOrchestrationService.ts': { maxLines: 516, maxFunctionLines: 164 },
  'src/providers/viewProjectionService.ts': { maxFunctionLines: 127 },
  'src/test/extension.test.ts': { maxLines: 1041 },
  'src/test/installUpdate.unit.test.ts': { maxLines: 1555 },
  'src/test/packagesProvider.unit.test.ts': { maxLines: 4191 },
  'src/test/registryClient.unit.test.ts': { maxLines: 1360 },
  'src/test/verifyVsix.unit.test.ts': { maxLines: 885 },
  'src/tools/auditSignatures.ts': { maxFunctionLines: 77 },
  'src/tools/releaseCandidate.ts': { maxFunctionLines: 64 },
  'src/utils/auditClient.ts': { maxFunctionLines: 88 },
  'src/utils/bunConfig.ts': { maxFunctionLines: 61 },
  'src/utils/shellTask.ts': { maxFunctionLines: 77 },
  'src/utils/yarnAuditClient.ts': { maxLines: 315 },
};

const PRODUCT_LIMITS = { maxLines: 300, maxFunctionLines: 60 };
const TEST_LIMITS = { maxLines: 800 };

function maxLinesRule(max) {
  return ['error', { max, skipBlankLines: true, skipComments: true }];
}

function sizeLimitConfigs() {
  return [
    {
      name: 'app/size-limits-product',
      files: ['src/**/*.{ts,mts}'],
      ignores: ['src/test/**'],
      rules: {
        'max-lines': maxLinesRule(PRODUCT_LIMITS.maxLines),
        'max-lines-per-function': maxLinesRule(PRODUCT_LIMITS.maxFunctionLines),
      },
    },
    {
      name: 'app/size-limits-test',
      files: ['src/test/**/*.{ts,mts}'],
      rules: {
        'max-lines': maxLinesRule(TEST_LIMITS.maxLines),
        'max-lines-per-function': 'off',
      },
    },
    ...Object.entries(SIZE_LIMIT_EXCEPTIONS).map(([file, ceilings]) => ({
      name: `app/size-limit-exception/${file}`,
      files: [file],
      rules: {
        ...(ceilings.maxLines === undefined ? {} : { 'max-lines': maxLinesRule(ceilings.maxLines) }),
        ...(ceilings.maxFunctionLines === undefined ? {} : { 'max-lines-per-function': maxLinesRule(ceilings.maxFunctionLines) }),
      },
    })),
  ];
}

export default [
  {
    name: 'app/files-to-lint',
    files: ['**/*.{ts,mts}'],
  },
  gitignore({
    filesGitModules: [],
  }),
  {
    files: ['**/*.{ts,mts}'],
    plugins: {
      '@typescript-eslint': typescriptEslint.plugin,
    },
    languageOptions: {
      parser: typescriptEslint.parser,
      parserOptions: {
        project: './tsconfig.json',
      },
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/naming-convention': ['warn', {
        selector: 'import',
        format: ['camelCase', 'PascalCase'],
      }],
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',

      curly: 'warn',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
      'require-await': 'warn',
      'sort-imports': ['warn', {
        ignoreCase: true,
        ignoreDeclarationSort: true,
        ignoreMemberSort: false,
        memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
      }],
    },
  },
  sonarjs.configs.recommended,
  {
    rules: {
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-commented-code': 'off',
      'sonarjs/todo-tag': 'off',
      'sonarjs/no-hardcoded-credentials': 'off',
      'sonarjs/pseudo-random': 'off',
      'sonarjs/function-return-type': 'off',
      'sonarjs/redundant-type-aliases': 'off',
      'sonarjs/prefer-function-type': 'off',
      'sonarjs/argument-type': 'off',
      'sonarjs/different-types-comparison': 'off',
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-nested-template-literals': 'off',
      'sonarjs/concise-regex': 'off',
      'sonarjs/prefer-regexp-exec': 'off',
    },
  },
  stylistic.configs.customize({
    indent: 2,
    quoteProps: 'as-needed',
    semi: true,
  }),
  {
    rules: {
      '@stylistic/multiline-comment-style': 'off',
      '@stylistic/max-statements-per-line': 'off',
      '@stylistic/object-curly-spacing': ['warn', 'always'],
      '@stylistic/no-multiple-empty-lines': ['warn', { max: 1 }],
      '@stylistic/eol-last': ['warn', 'never'],
      '@stylistic/function-call-argument-newline': ['warn', 'consistent'],
    },
  },
  ...sizeLimitConfigs(),
];