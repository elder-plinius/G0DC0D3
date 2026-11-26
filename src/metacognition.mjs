import { classifyPromptDomain, ROUTER_DOMAINS } from './ultra-router.mjs';

export const METACOGNITION_MODES = Object.freeze(['off', 'smart', 'auto_forge']);

export function normalizeMetacognitionMode(value, fallback = 'smart') {
  const v = String(value || '').trim().toLowerCase();
  return METACOGNITION_MODES.includes(v) ? v : fallback;
}

export function detectModelFamily(providerOrId) {
  const raw = typeof providerOrId === 'string'
    ? providerOrId
    : `${providerOrId?.id || ''} ${providerOrId?.model || ''} ${providerOrId?.label || ''}`;
  const s = raw.toLowerCase();
  if (/gemini|neon/.test(s)) return 'gemini';
  if (/claude|anthropic|sonnet|opus|haiku/.test(s)) return 'anthropic';
  if (/gpt-|o1\b|o3\b|o4\b|codex|openai/.test(s)) return 'openai';
  if (/deepseek/.test(s)) return 'deepseek';
  return 'open_weight';
}

const FAMILY_CALIBRATION = Object.freeze({
  gemini: 'Leverage native deep reasoning before acting; keep tool calls parallel and surgical; verify deliverables directly against the rubric.',
  anthropic: 'Anchor every claim to inspected evidence; make minimal targeted edits that preserve existing conventions and architecture.',
  openai: 'Lock invariants early, batch independent read-only inspections, and deterministically verify boundary conditions.',
  deepseek: 'Skip repetitive re-derivation; lock the interface contract up front and double-check edge cases before finalizing.',
  open_weight: 'Follow the deliverable contract strictly, produce complete runnable artifacts with zero placeholders, and self-check every requirement.'
});

const DOMAIN_PROTOCOLS = Object.freeze({
  swe_coding: {
    title: 'Systems & SWE Metacognition',
    protocol: 'Inspect exact files and call sites before editing. Isolate root cause vs symptom, keep diffs minimal and idiomatic, check concurrency/null/error paths, and run real checks before reporting completion.',
    failureModes: [
      'Editing without reading surrounding callers or state invariants',
      'Introducing regressions in sibling paths or error handling',
      'Claiming verification without running actual checks'
    ],
    rubric: [
      'Root cause fixed cleanly with minimal blast radius',
      'Edge cases, error paths, and existing contracts preserved',
      'Independent syntax/test verification passes'
    ]
  },
  frontend_ui: {
    title: 'Visual Craft & UI Metacognition',
    protocol: 'Establish clear typographic hierarchy, balanced spacing, and cohesive surface contrast in both dark and light states. Deliver self-contained zero-CDN runnable code when building interactive previews, and inspect rendered geometry/overflow.',
    failureModes: [
      'Broken external CDN links or missing inline runtime handlers',
      'Clipped labels, uneven padding, or low-contrast text on theme switch',
      'Dead interactive states or unstyled empty/loading states'
    ],
    rubric: [
      'Cohesive visual hierarchy, spacing, and responsive alignment',
      'All interactive controls function cleanly with zero console errors',
      'Zero external broken assets and clean contrast'
    ]
  },
  math_reasoning: {
    title: 'Formal Logic & Math Metacognition',
    protocol: 'State definitions, domain constraints, and invariants first. Derive step-by-step without hand-waving, then test the result on boundary cases (0, 1, negatives, degenerate inputs, asymptotic limits) before concluding.',
    failureModes: [
      'Off-by-one indexing or sign/unit flip mid-derivation',
      'Hidden assumption that fails on boundary or degenerate inputs',
      'Unverified final simplification or arithmetic slip'
    ],
    rubric: [
      'Assumptions and invariants explicitly stated',
      'Derivation is airtight with no skipped critical steps',
      'Boundary sanity checks confirm final answer'
    ]
  },
  security_research: {
    title: 'Authorized Security Research Metacognition',
    protocol: 'Operate with rigorous technical objectivity: map attack surfaces, trace concrete data/control flows, cite exact mechanisms and preconditions, and pair analysis with actionable hardening or verification evidence.',
    failureModes: [
      'Vague high-level generalizations instead of concrete mechanics',
      'Missing preconditions, privilege boundaries, or reproduction constraints',
      'Overlooking defense-in-depth remediation or detection vectors'
    ],
    rubric: [
      'Concrete mechanism and preconditions accurately traced',
      'Direct, rigorous technical signal without filler',
      'Clear verification criteria or concrete mitigations'
    ]
  },
  creative_writing: {
    title: 'Editorial Voice & Craft Metacognition',
    protocol: 'Prioritize concrete imagery, sharp pacing, and unmistakable voice fidelity. Eliminate generic filler, cliché openings, and throat-clearing; make every paragraph earn its weight.',
    failureModes: [
      'Generic AI cadence, repetitive transitions, or hedged conclusions',
      'Drifting away from the requested tone, format, or audience',
      'Telling instead of showing key beats'
    ],
    rubric: [
      'Distinct, consistent voice matching the brief',
      'Zero filler clichés or padded transitions',
      'Tight structure with a memorable opening and close'
    ]
  },
  long_context: {
    title: 'Deep Synthesis & Citation Metacognition',
    protocol: 'Map the corpus topology first, cross-check contradictions across sections/files, and anchor every major conclusion to exact file paths, symbols, or quoted spans.',
    failureModes: [
      'Missing critical details buried in middle sections',
      'Conflating distinct files, versions, or speakers',
      'Unanchored summaries that omit concrete references'
    ],
    rubric: [
      'Covers full scope without overlooking middle/tail sections',
      'Claims anchored to exact files, symbols, or passages',
      'Contradictions and gaps explicitly surfaced'
    ]
  },
  vision_multimodal: {
    title: 'Visual Inspection & Grounding Metacognition',
    protocol: 'Examine layout, typography, alignment, contrast, clipped elements, and state indicators systematically from top-left to bottom-right before proposing fixes.',
    failureModes: [
      'Hallucinating UI text or controls not visible in the image',
      'Missing subtle clipping, overlap, or contrast defects',
      'Giving generic advice instead of pixel-grounded observations'
    ],
    rubric: [
      'Observations strictly grounded in visible pixels',
      'Layout, contrast, and text defects specifically localized',
      'Proposed changes directly address observed visual issues'
    ]
  }
});

/**
 * Tier 1 — 0ms, prefix-cache-safe Domain × Model-Family Metacognitive Framing.
 * Returns null for fast_general or effort='fast' to preserve instant chat speed.
 */
export function buildDomainMetacognition({
  domain,
  secondaryDomain = null,
  refusalRisk = 0,
  modelFamily = 'open_weight',
  effort = 'medium',
  workspaceKind = 'conversation',
  providerLabel = null
} = {}) {
  if (!domain || domain === 'fast_general' || effort === 'fast') return null;
  const spec = DOMAIN_PROTOCOLS[domain];
  if (!spec) return null;
  const famKey = FAMILY_CALIBRATION[modelFamily] ? modelFamily : 'open_weight';
  const famTip = FAMILY_CALIBRATION[famKey];
  const domainMeta = ROUTER_DOMAINS.find(d => d.id === domain);
  const compiledBrief = [
    `[${spec.title} · ${famKey}]`,
    `Protocol: ${spec.protocol}`,
    `Model calibration: ${famTip}`,
    `Watch out for: ${spec.failureModes.join('; ')}.`,
    `Self-check before finishing: ${spec.rubric.join(' | ')}.`
  ].join('\n');

  return {
    tier: 'smart',
    domain,
    domainLabel: domainMeta?.shortLabel || domain,
    secondaryDomain,
    refusalRisk,
    modelFamily: famKey,
    providerLabel: providerLabel || null,
    title: spec.title,
    intentLock: null,
    failureModes: [...spec.failureModes],
    rubric: [...spec.rubric],
    executionPlan: `${spec.protocol} ${famTip}`,
    compiledBrief,
    durationMs: 0,
    workspaceKind
  };
}

export function shouldAutoForge({ objective = '', domain = 'fast_general', effort = 'medium', isFirstTurn = true, mode = 'smart' } = {}) {
  if (mode !== 'auto_forge') return false;
  if (!isFirstTurn) return false;
  if (domain === 'fast_general' || effort === 'fast') return false;
  const text = String(objective || '').trim();
  if (text.length < 55) return false;
  return true;
}

const FORGE_SYSTEM_PROMPT = `You are the Ultra-Plinian Metaprompt Architect.
Given a user's task, its classified domain, and the target executing model family, synthesize a compact, surgical task-specific metacognition brief that maximizes first-pass quality WITHOUT adding latency bloat or inventing scope.

STRICT RULES:
1. INTENT LOCK: Preserve the user's exact request. NEVER invent unrequested features, libraries, frameworks, or requirements.
2. FAILURE MODES: List 3-4 concrete, task-specific traps that usually ruin a first-pass attempt on this exact prompt.
3. ACCEPTANCE RUBRIC: List 3-4 sharp, objective pass/fail checks the executing model (and Arena judge) can verify against.
4. MODEL-TAILORED EXECUTION: Give a crisp 2-3 sentence execution strategy calibrated to the target model family (for reasoning models like Gemini 4 Neon / Claude / o-series, emphasize invariants & verification rather than bloated step-by-step CoT scripts).

Return ONLY valid JSON with exact keys:
{"intentLock":"...","failureModes":["..."],"rubric":["..."],"executionPlan":"..."}`;

function parseForgeJson(rawText) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const intentLock = typeof obj.intentLock === 'string' ? obj.intentLock.trim().slice(0, 420) : '';
    const executionPlan = typeof obj.executionPlan === 'string' ? obj.executionPlan.trim().slice(0, 600) : '';
    const failureModes = Array.isArray(obj.failureModes)
      ? obj.failureModes.map(s => String(s || '').trim().slice(0, 200)).filter(Boolean).slice(0, 5)
      : [];
    const rubric = Array.isArray(obj.rubric)
      ? obj.rubric.map(s => String(s || '').trim().slice(0, 200)).filter(Boolean).slice(0, 5)
      : [];
    if (!intentLock || !rubric.length || !executionPlan) return null;
    return { intentLock, failureModes, rubric, executionPlan };
  } catch {
    return null;
  }
}

/**
 * Tier 2 — Live LLM Megaprompt Architect (✦ Forge).
 * Gracefully falls back to Tier 1 smart framing on timeout, error, or malformed JSON.
 */
export async function forgeTaskMegaprompt({
  objective = '',
  domain = null,
  modelFamily = null,
  targetProvider = null,
  architectProvider = null,
  effort = 'medium',
  workspaceKind = 'conversation',
  files = [],
  attachments = [],
  signal = null,
  outbound = {},
  timeoutMs = 14000
} = {}) {
  const started = Date.now();
  const classification = domain
    ? { primaryDomain: domain, secondaryDomain: null, refusalRisk: 0 }
    : classifyPromptDomain(objective, { files, attachments });
  const dom = classification.primaryDomain;
  const fam = modelFamily || detectModelFamily(targetProvider || architectProvider || '');
  const fallback = buildDomainMetacognition({
    domain: dom === 'fast_general' ? 'swe_coding' : dom,
    secondaryDomain: classification.secondaryDomain,
    refusalRisk: classification.refusalRisk,
    modelFamily: fam,
    effort: effort === 'fast' ? 'medium' : effort,
    workspaceKind,
    providerLabel: targetProvider?.label || targetProvider?.id || null
  });

  const runner = architectProvider || targetProvider;
  if (!runner || runner.available === false || runner.closed) {
    return { ...fallback, fallbackReason: 'no_architect_provider' };
  }

  const domainMeta = ROUTER_DOMAINS.find(d => d.id === dom);
  const userBrief = [
    `Domain: ${domainMeta?.label || dom}`,
    `Target model family: ${fam}${targetProvider?.label ? ` (${targetProvider.label})` : ''}`,
    `Workspace mode: ${workspaceKind}`,
    `User prompt:\n${String(objective || '').trim().slice(0, 4000)}`
  ].join('\n');

  const timer = AbortSignal.timeout(Math.max(2000, Math.min(25000, Number(timeoutMs) || 14000)));
  const combinedSignal = signal ? AbortSignal.any([signal, timer]) : timer;

  let rawText = '';
  try {
    if (typeof runner.draft === 'function') {
      const res = await runner.draft(
        [{ role: 'system', content: FORGE_SYSTEM_PROMPT }, { role: 'user', content: userBrief }],
        combinedSignal,
        900,
        { temperature: 0.2 },
        outbound
      );
      if (res?.type === 'message' && typeof res.text === 'string') rawText = res.text;
    } else if (typeof runner.turn === 'function') {
      const res = await runner.turn({
        task: {
          id: 'forge-ephemeral',
          workspaceKind: 'conversation',
          objective: `${FORGE_SYSTEM_PROMPT}\n\n${userBrief}`,
          calls: 1,
          attachments: [],
          constraints: [],
          followups: [],
          execution: { enabled: false, network: false },
          policy: { maxCalls: 1, maxAttempts: 1 }
        },
        history: [],
        files: [],
        tools: [],
        manifest: { bytes: Buffer.byteLength(userBrief), omittedEventCount: 0, omittedFiles: [] }
      }, { signal: combinedSignal, ...outbound });
      if (res?.type === 'message' && typeof res.text === 'string') rawText = res.text;
    }
  } catch {
    return { ...fallback, fallbackReason: 'forge_error', durationMs: Date.now() - started };
  }

  const parsed = parseForgeJson(rawText);
  if (!parsed) {
    return { ...fallback, fallbackReason: 'forge_parse_fallback', durationMs: Date.now() - started };
  }

  const compiledBrief = [
    `[✦ Ultra-Forge Megaprompt · ${domainMeta?.shortLabel || dom} · ${fam}]`,
    `Intent lock: ${parsed.intentLock}`,
    `Execution strategy: ${parsed.executionPlan}`,
    parsed.failureModes.length ? `Failure traps to avoid:\n- ${parsed.failureModes.join('\n- ')}` : '',
    `Acceptance rubric (verify before concluding):\n- ${parsed.rubric.join('\n- ')}`
  ].filter(Boolean).join('\n');

  return {
    tier: 'forged',
    domain: dom,
    domainLabel: domainMeta?.shortLabel || dom,
    secondaryDomain: classification.secondaryDomain || null,
    refusalRisk: classification.refusalRisk || 0,
    modelFamily: fam,
    architectId: runner.id || null,
    architectLabel: runner.label || runner.model || runner.id || null,
    providerLabel: targetProvider?.label || targetProvider?.id || null,
    title: `✦ Forged Megaprompt (${domainMeta?.shortLabel || dom})`,
    intentLock: parsed.intentLock,
    failureModes: parsed.failureModes,
    rubric: parsed.rubric,
    executionPlan: parsed.executionPlan,
    compiledBrief,
    durationMs: Date.now() - started,
    workspaceKind
  };
}

/**
 * Formats a compact acceptance rubric addendum for the Ultra-Plinian Blind Judge.
 */
export function formatJudgeRubricBlock(metacognition) {
  if (!metacognition || !Array.isArray(metacognition.rubric) || !metacognition.rubric.length) return '';
  const lines = [
    '\nTask-specific evaluation rubric (apply when scoring fidelity & completeness):',
    ...(metacognition.intentLock ? [`- Exact intent: ${metacognition.intentLock}`] : []),
    ...metacognition.rubric.slice(0, 5).map(r => `- ${r}`)
  ];
  return lines.join('\n');
}
