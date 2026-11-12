import stylistic from '@stylistic/eslint-plugin';
import gitignore from 'eslint-config-flat-gitignore';
import sonarjs from 'eslint-plugin-sonarjs';
import typescriptEslint from 'typescript-eslint';

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