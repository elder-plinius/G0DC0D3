/**
 * Workflow presets — named effort-level bundles that expand into
 * policy + execution + persona configurations at task creation time.
 *
 * Like Codex's effort modes but tuned for the ultra-plinian pipeline:
 * each preset adjusts how many calls/recoveries/strategies the runtime
 * will burn before giving up, whether execution is enabled, and how
 * aggressively the reframe pipeline escalates.
 */

export const WORKFLOW_PRESETS = {
  quick: {
    label: 'Quick',
    description: 'Fast single-pass. Minimal recovery, no execution. Good for simple edits and questions.',
    policy: {
      mode: 'adaptive',
      maxAttempts: 3,
      maxCalls: 10,
      strategies: ['continue'],
      requestTimeoutMs: 60000,
      maxNoProgressTurns: 2,
      returnToPrimary: false,
      learning: false,
    },
    execution: { enabled: false, network: false },
    persona: 'focused',
  },

  standard: {
    label: 'Standard',
    description: 'Balanced multi-step with moderate recovery. The default for most coding tasks.',
    policy: {
      mode: 'adaptive',
      maxAttempts: 15,
      maxCalls: 60,
      strategies: ['continue', 'decompose', 'reproduce-first', 'alternate-approach'],
      requestTimeoutMs: 90000,
      maxNoProgressTurns: 3,
      returnToPrimary: true,
      learning: true,
    },
    execution: { enabled: false, network: false },
    persona: 'plinian',
  },

  high: {
    label: 'High Effort',
    description: 'Extended budget with execution enabled. For multi-file features and complex debugging.',
    policy: {
      mode: 'adaptive',
      maxAttempts: 30,
      maxCalls: 150,
      strategies: ['continue', 'decompose', 'reproduce-first', 'alternate-approach', 'escalate'],
      requestTimeoutMs: 60000,
      maxNoProgressTurns: 5,
      returnToPrimary: true,
      learning: true,
    },
    execution: { enabled: true, network: false, timeoutMs: 30000 },
    persona: 'plinian',
  },

  ultra: {
    label: 'Ultra',
    description: 'Maximum budget, full model rotation, execution enabled (offline). For hard multi-component tasks that need the full pipeline.',
    policy: {
      mode: 'adaptive',
      maxAttempts: 50,
      maxCalls: 300,
      strategies: ['continue', 'decompose', 'reproduce-first', 'alternate-approach', 'escalate', 'rewrite-objective'],
      requestTimeoutMs: 600000,
      maxNoProgressTurns: 8,
      returnToPrimary: true,
      learning: true,
    },
    execution: { enabled: true, network: false, timeoutMs: 60000 },
    persona: 'plinian',
  },

  'ultra-plinian': {
    label: 'G0DM0D3 extended recovery',
    description: 'Maximum recovery depth, full reframe pipeline, command execution, and extended timeouts. Enable command networking separately when needed.',
    policy: {
      mode: 'adaptive',
      maxAttempts: 100,
      maxCalls: 1000,
      strategies: ['continue', 'decompose', 'reproduce-first', 'alternate-approach', 'escalate', 'rewrite-objective', 'brute-rotate'],
      requestTimeoutMs: 600000,
      maxNoProgressTurns: 6,
      returnToPrimary: true,
      learning: true,
    },
    execution: { enabled: true, network: false, timeoutMs: 60000 },
    persona: 'plinian',
  },
};

export const WORKFLOW_NAMES = Object.keys(WORKFLOW_PRESETS);

export function resolveWorkflow(name) {
  const preset = WORKFLOW_PRESETS[name];
  if (!preset) return null;
  return { policy: { ...preset.policy }, execution: { ...preset.execution }, persona: preset.persona };
}

export function listWorkflows() {
  return Object.entries(WORKFLOW_PRESETS).map(([name, preset]) => ({
    name,
    label: preset.label,
    description: preset.description,
    maxAttempts: preset.policy.maxAttempts,
    maxCalls: preset.policy.maxCalls,
    executionEnabled: preset.execution.enabled,
    networkEnabled: preset.execution.network,
  }));
}
