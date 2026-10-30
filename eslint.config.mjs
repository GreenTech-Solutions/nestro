import stylistic from '@stylistic/eslint-plugin';
import gitignore from 'eslint-config-flat-gitignore';
import sonarjs from 'eslint-plugin-sonarjs';
import typescriptEslint from 'typescript-eslint';

// Files that predate the size limits, each at its current measured size; a ceiling only goes down.
// maxLines caps the file, maxFunctionLines caps its longest function; delete a key once the file fits the default.
const SIZE_LIMIT_EXCEPTIONS = {
  'src/clients/projectResolver.ts': { maxLines: 325 },
  'src/commands/installUpdate.ts': { maxLines: 591, maxFunctionLines: 96 },
  'src/commands/pickVersion.ts': { maxFunctionLines: 116 },
  'src/commands/removePackage.ts': { maxFunctionLines: 62 },
  'src/extension.ts': { maxFunctionLines: 67 },
  'src/providers/PackageItem.ts': { maxFunctionLines: 90 },
  'src/providers/PackagesProvider.ts': { maxLines: 1626, maxFunctionLines: 173 },
  'src/providers/auditOrchestrationService.ts': { maxLines: 615, maxFunctionLines: 132 },
  'src/providers/packageIdentity.ts': { maxFunctionLines: 80 },
  'src/providers/packageLoadingService.ts': { maxFunctionLines: 77 },
  'src/providers/treeBuilder.ts': { maxLines: 628 },
  'src/providers/updateOrchestrationService.ts': { maxLines: 517, maxFunctionLines: 164 },
  'src/providers/viewProjectionService.ts': { maxFunctionLines: 127 },
  'src/test/extension.test.ts': { maxLines: 1074 },
  'src/test/installUpdate.unit.test.ts': { maxLines: 1555 },
  'src/test/packagesProvider.unit.test.ts': { maxLines: 4191 },
  'src/test/registryClient.unit.test.ts': { maxLines: 1362 },
  'src/test/verifyVsix.unit.test.ts': { maxLines: 892 },
  'src/tools/artifactProvenance.ts': { maxLines: 518, maxFunctionLines: 74 },
  'src/tools/artifactProvenanceCli.ts': { maxFunctionLines: 102 },
  'src/tools/auditSignatures.ts': { maxFunctionLines: 77 },
  'src/tools/ciPolicy.ts': { maxLines: 839, maxFunctionLines: 154 },
  'src/tools/ciPolicyCli.ts': { maxFunctionLines: 89 },
  'src/tools/releaseCandidate.ts': { maxFunctionLines: 70 },
  'src/tools/releaseCandidateCli.ts': { maxLines: 319, maxFunctionLines: 80 },
  'src/tools/releasePrepareCli.ts': { maxFunctionLines: 65 },
  'src/tools/releaseWorkflowPolicy.ts': { maxLines: 894, maxFunctionLines: 203 },
  'src/tools/verifyVsix.ts': { maxLines: 441 },
  'src/tools/verifyVsixCli.ts': { maxFunctionLines: 150 },
  'src/tools/vsixArchive.ts': { maxFunctionLines: 96 },
  'src/tools/vsixManifest.ts': { maxLines: 584, maxFunctionLines: 75 },
  'src/tools/vsixPolicy.ts': { maxLines: 480 },
  'src/utils/auditClient.ts': { maxLines: 450, maxFunctionLines: 88 },
  'src/utils/bunAuditClient.ts': { maxFunctionLines: 66 },
  'src/utils/bunConfig.ts': { maxLines: 301, maxFunctionLines: 61 },
  'src/utils/metadataRunner.ts': { maxFunctionLines: 138 },
  'src/utils/packageTransforms.ts': { maxLines: 315 },
  'src/utils/processRunner.ts': { maxLines: 348, maxFunctionLines: 162 },
  'src/utils/registryClient.ts': { maxLines: 1320, maxFunctionLines: 90 },
  'src/utils/shellTask.ts': { maxFunctionLines: 77 },
  'src/utils/yarnAuditClient.ts': { maxLines: 402 },
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