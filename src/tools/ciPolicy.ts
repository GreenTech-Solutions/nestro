import { isDeepStrictEqual } from 'node:util';
import { CI_WORKFLOW_CONTRACT } from './ciWorkflowContract';
import { RELEASE_CONTRACT } from './releaseContract';
import type { ReviewedActionsRegistry } from './reviewedActions';
import { checkWorkflowContract } from './workflowContract';
import { loadStrictYaml } from './workflowYaml';
import type { UnknownRecord, WorkflowViolation } from './workflowYaml';

export const CODEOWNERS_PATH = '.github/CODEOWNERS';
export const CI_WORKFLOW_PATH = RELEASE_CONTRACT.workflows.signerPath;
export const DEPENDABOT_CONFIG_PATH = '.github/dependabot.yml';
export const WORKFLOWS_DIRECTORY_PATH = '.github/workflows';

const EXPECTED_CODEOWNERS = '/.github/ @GreenTech-Solutions\n';
const EXPECTED_DEPENDABOT_CONFIG: UnknownRecord = {
  updates: [{
    'commit-message': {
      prefix: 'ci(deps)',
    },
    directory: '/',
    'open-pull-requests-limit': 2,
    'package-ecosystem': 'github-actions',
    schedule: {
      day: 'monday',
      interval: 'weekly',
      time: '04:00',
      timezone: 'UTC',
    },
  }],
  version: 2,
};

export function evaluateDependabotConfigPolicy(source: string): WorkflowViolation[] {
  const loaded = loadStrictYaml(source, { rule: 'dependabot-yaml', subject: 'Dependabot configuration' });
  if (!loaded.loaded) {
    return loaded.violations;
  }
  if (!isDeepStrictEqual(loaded.value, EXPECTED_DEPENDABOT_CONFIG)) {
    return [{
      rule: 'dependabot-contract',
      message: 'Dependabot must use the exact reviewed standalone github-actions update contract',
    }];
  }
  return [];
}

export function evaluateCodeownersPolicy(source: string): WorkflowViolation[] {
  if (source !== EXPECTED_CODEOWNERS) {
    return [{
      rule: 'codeowners-contract',
      message: '.github must be owned exactly by @GreenTech-Solutions, including CODEOWNERS itself',
    }];
  }
  return [];
}

export function evaluateCiWorkflowPolicy(source: string, registry: ReviewedActionsRegistry): WorkflowViolation[] {
  const loaded = loadStrictYaml(source, { rule: 'yaml', subject: 'Workflow' });
  return loaded.loaded ? checkWorkflowContract(loaded.value, CI_WORKFLOW_CONTRACT, registry) : loaded.violations;
}