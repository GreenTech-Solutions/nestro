export const PACKAGE_PRESENTATION = {
  rootLabel: '(root)',
  updateTypes: {
    breaking: { icon: 'triangle-up', color: 'charts.red' },
    minor: { icon: 'arrow-up', color: 'charts.yellow' },
    patch: { icon: 'arrow-small-up', color: 'charts.green' },
    none: { icon: 'check', color: 'charts.green' },
  },
  dependencyIcons: {
    dependencies: 'package',
    devDependencies: 'tools',
  },
  filterColors: {
    all: undefined,
    hasUpdates: 'charts.blue',
    patch: 'charts.green',
    minor: 'charts.yellow',
    breaking: 'charts.red',
    vulnerable: 'charts.red',
  },
} as const;