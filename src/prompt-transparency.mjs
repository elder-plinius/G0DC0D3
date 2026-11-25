/**
 * Prompt Transparency, Editable Tool Schemas, and Prefills / Injections Lab.
 * Zero-dependency, local-only state persisted in SQLite via store.getLocalState.
 */
import { TOOLS } from './tool-schema.mjs';
import {
  DEFAULT_AGENT_CONTRACT,
  DEFAULT_CATALOG_TOOLS_HEADER,
  DEFAULT_CONVERSATION_INSTRUCTIONS,
  DEFAULT_EFFORT_PROMPTS,
  DEFAULT_LIVE_PREVIEW_HINT,
  DEFAULT_PLAN_MODE_INSTRUCTIONS,
  PERSONAS,
  applySystemEnvelope,
  buildToolPlaybook,
  compileInstructions,
  effortInstructions,
  resolvePersona,
} from './prompts.mjs';

const DEFAULT_PLAYBOOK_TOOLS = TOOLS.map(t => t.name);

export const SYSTEM_PROMPT_CATALOG = Object.freeze([
  {
    id: 'agentContract',
    group: 'Core Engine',
    title: 'Agent Engine Contract',
    description: 'Core engineering, tool-use, verification, and handoff discipline sent to GODCODƎ & tool-loop models.',
    defaultValue: () => DEFAULT_AGENT_CONTRACT,
  },
  {
    id: 'conversation',
    group: 'Core Engine',
    title: 'Conversation Workspace Rules',
    description: 'Guidance for chat-first conversations (direct answers, live browser/web tools, offline HTML5 preview canvas).',
    defaultValue: () => DEFAULT_CONVERSATION_INSTRUCTIONS,
  },
  {
    id: 'planMode',
    group: 'Core Engine',
    title: 'Plan Mode (Read-Only)',
    description: 'Instructions enforced when Plan Mode (/plan) is active.',
    defaultValue: () => DEFAULT_PLAN_MODE_INSTRUCTIONS,
  },
  {
    id: 'toolPlaybook',
    group: 'Core Engine',
    title: 'Tool Playbook',
    description: 'Dynamic tool instructions for Contained Browser, Web Research, Subagents, Memory, Shell, and Error Recovery.',
    defaultValue: () => buildToolPlaybook(DEFAULT_PLAYBOOK_TOOLS, { execEnabled: true }).trim(),
  },
  {
    id: 'livePreviewHint',
    group: 'Core Engine',
    title: 'Direct Chat · Live Preview Canvas',
    description: 'Instructions telling direct-chat models (Venice Catalog) how to emit live HTML/CSS/JS/SVG previews.',
    defaultValue: () => DEFAULT_LIVE_PREVIEW_HINT,
  },
  {
    id: 'catalogToolsHeader',
    group: 'Core Engine',
    title: 'Direct Chat · Live Tools Header',
    description: 'Header appended to direct-chat system prompts whenever live tools (Browser, Web, Workspace) are attached.',
    defaultValue: () => DEFAULT_CATALOG_TOOLS_HEADER,
  },
  {
    id: 'customAppend',
    group: 'Core Engine',
    title: 'Custom Global System Appendix',
    description: 'Appended verbatim to the end of every non-fixture system prompt across all providers (empty by default).',
    defaultValue: () => '',
  },
  {
    id: 'personaPlinian',
    group: 'Personas',
    title: 'Persona · Plinian',
    description: 'Voice instructions for the default Plinian personality.',
    defaultValue: () => PERSONAS.plinian.instructions,
  },
  {
    id: 'personaFocused',
    group: 'Personas',
    title: 'Persona · Focused',
    description: 'Voice instructions for the Focused personality.',
    defaultValue: () => PERSONAS.focused.instructions,
  },
  {
    id: 'effortFast',
    group: 'Thinking Effort',
    title: 'Effort · ⚡ Fast',
    description: 'Prompt instructions injected when composer Effort is set to Fast.',
    defaultValue: () => DEFAULT_EFFORT_PROMPTS.fast,
  },
  {
    id: 'effortMedium',
    group: 'Thinking Effort',
    title: 'Effort · ◔ Medium',
    description: 'Prompt instructions injected when composer Effort is set to Medium.',
    defaultValue: () => DEFAULT_EFFORT_PROMPTS.medium,
  },
  {
    id: 'effortHigh',
    group: 'Thinking Effort',
    title: 'Effort · ◕ High',
    description: 'Prompt instructions injected when composer Effort is set to High.',
    defaultValue: () => DEFAULT_EFFORT_PROMPTS.high,
  },
  {
    id: 'effortMax',
    group: 'Thinking Effort',
    title: 'Effort · ● Max',
    description: 'Prompt instructions injected when composer Effort is set to Max.',
    defaultValue: () => DEFAULT_EFFORT_PROMPTS.max,
  },
]);

const PROMPT_CATALOG_MAP = new Map(SYSTEM_PROMPT_CATALOG.map(entry => [entry.id, entry]));
const TOOL_MAP = new Map(TOOLS.map(tool => [tool.name, tool]));

export const DEFAULT_INJECTIONS = Object.freeze({
  enabled: false,
  systemPrefix: '',
  systemSuffix: '',
  fewShotUser: '',
  fewShotAssistant: '',
  userPrefix: '',
  userSuffix: '',
  reasoningPrefill: '',
  assistantPrefill: '',
  stitchPrefill: true,
});

export const INJECTION_PRESETS = Object.freeze([
  {
    id: 'direct_prefill',
    label: 'Direct Answer Prefill',
    description: 'Prefills the opening tokens of the assistant turn to skip preamble.',
    patch: {
      enabled: true,
      assistantPrefill: 'Sure — here is the complete, direct answer:\n\n',
      reasoningPrefill: '',
      stitchPrefill: true,
    },
  },
  {
    id: 'reasoning_seed',
    label: 'Reasoning <think> Seed',
    description: 'Seeds a <think> reasoning trace for open-weight reasoning models (DeepSeek, Qwen, QwQ, Venice).',
    patch: {
      enabled: true,
      reasoningPrefill: 'Let me break down every requirement, check edge cases and available tools, and deliver a complete verified solution:\n1. ',
      assistantPrefill: '',
      stitchPrefill: true,
    },
  },
  {
    id: 'json_prefill',
    label: 'Strict JSON Prefill',
    description: 'Forces raw JSON output by prefilling an opening brace and adding a user-turn constraint.',
    patch: {
      enabled: true,
      userSuffix: '\n\nRespond with valid JSON only (no markdown fences).',
      assistantPrefill: '{\n  ',
      reasoningPrefill: '',
      stitchPrefill: true,
    },
  },
  {
    id: 'xml_framing',
    label: 'XML Task Framing',
    description: 'Wraps every user message in explicit <request> delimiters with concise directives.',
    patch: {
      enabled: true,
      userPrefix: '<request>\n',
      userSuffix: '\n</request>\nAnswer directly with zero fluff.',
      assistantPrefill: '',
      reasoningPrefill: '',
    },
  },
  {
    id: 'clear',
    label: 'Clear All Slots',
    description: 'Disables injections and clears all prefill/injection fields.',
    patch: { ...DEFAULT_INJECTIONS },
  },
]);

export const DEFAULT_TRANSPARENCY_CONFIG = Object.freeze({
  prompts: Object.freeze({}),
  tools: Object.freeze({}),
  injections: DEFAULT_INJECTIONS,
});

function fault(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

function toolCategory(name) {
  if (name.startsWith('repo.')) return 'Workspace';
  if (name.startsWith('browser.')) return 'Browser';
  if (name.startsWith('web.')) return 'Web';
  if (name.startsWith('git.')) return 'Git';
  if (name.startsWith('process.') || name.startsWith('check.')) return 'Shell & Checks';
  if (name.startsWith('memory.')) return 'Memory';
  return 'Agents & Tasks';
}

function validateParametersSchema(schema, toolName) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw fault('INVALID_TOOL_SCHEMA', `Tool "${toolName}" parameters must be a JSON Schema object.`);
  }
  if (schema.type !== 'object') {
    throw fault('INVALID_TOOL_SCHEMA', `Tool "${toolName}" parameters.type must be "object".`);
  }
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    throw fault('INVALID_TOOL_SCHEMA', `Tool "${toolName}" parameters.properties must be an object.`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string'))) {
    throw fault('INVALID_TOOL_SCHEMA', `Tool "${toolName}" parameters.required must be an array of strings.`);
  }
  const serialized = JSON.stringify(schema);
  if (serialized.length > 32768) {
    throw fault('INVALID_TOOL_SCHEMA', `Tool "${toolName}" parameters schema exceeds 32 KiB.`);
  }
  return JSON.parse(serialized);
}

export function normalizeTransparencyConfig(input = {}, previous = DEFAULT_TRANSPARENCY_CONFIG) {
  const prev = previous && typeof previous === 'object' ? previous : DEFAULT_TRANSPARENCY_CONFIG;
  const prompts = { ...(prev.prompts && typeof prev.prompts === 'object' ? prev.prompts : {}) };
  const tools = {};
  if (prev.tools && typeof prev.tools === 'object') {
    for (const [k, v] of Object.entries(prev.tools)) {
      if (TOOL_MAP.has(k) && v && typeof v === 'object') tools[k] = structuredClone(v);
    }
  }
  const injections = { ...DEFAULT_INJECTIONS, ...(prev.injections && typeof prev.injections === 'object' ? prev.injections : {}) };

  if (input && typeof input === 'object') {
    if (input.prompts !== undefined) {
      if (!input.prompts || typeof input.prompts !== 'object' || Array.isArray(input.prompts)) {
        throw fault('INVALID_TRANSPARENCY', 'prompts must be an object map.');
      }
      for (const [id, val] of Object.entries(input.prompts)) {
        const spec = PROMPT_CATALOG_MAP.get(id);
        if (!spec) throw fault('INVALID_TRANSPARENCY', `Unknown system prompt block "${id}".`);
        if (val === null) {
          delete prompts[id];
          continue;
        }
        if (typeof val !== 'string') throw fault('INVALID_TRANSPARENCY', `Prompt "${id}" must be a string or null.`);
        if (val.length > 32768) throw fault('INVALID_TRANSPARENCY', `Prompt "${id}" exceeds 32,768 characters.`);
        if (val === spec.defaultValue()) delete prompts[id];
        else prompts[id] = val;
      }
    }

    if (input.tools !== undefined) {
      if (!input.tools || typeof input.tools !== 'object' || Array.isArray(input.tools)) {
        throw fault('INVALID_TRANSPARENCY', 'tools must be an object map.');
      }
      for (const [name, patch] of Object.entries(input.tools)) {
        const canonical = TOOL_MAP.get(name);
        if (!canonical) throw fault('INVALID_TRANSPARENCY', `Unknown tool "${name}".`);
        if (patch === null) {
          delete tools[name];
          continue;
        }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw fault('INVALID_TRANSPARENCY', `Tool override for "${name}" must be an object or null.`);
        }
        const entry = { ...(tools[name] || {}) };
        if (Object.hasOwn(patch, 'enabled')) {
          if (patch.enabled === null || patch.enabled === true) delete entry.enabled;
          else if (patch.enabled === false) entry.enabled = false;
          else throw fault('INVALID_TRANSPARENCY', `Tool "${name}" enabled must be boolean.`);
        }
        if (Object.hasOwn(patch, 'description')) {
          if (patch.description === null || patch.description === canonical.description) {
            delete entry.description;
          } else {
            if (typeof patch.description !== 'string' || !patch.description.trim()) {
              throw fault('INVALID_TRANSPARENCY', `Tool "${name}" description must be a non-empty string.`);
            }
            if (patch.description.length > 4096) {
              throw fault('INVALID_TRANSPARENCY', `Tool "${name}" description exceeds 4,096 characters.`);
            }
            entry.description = patch.description.trim();
          }
        }
        if (Object.hasOwn(patch, 'parameters')) {
          if (patch.parameters === null) {
            delete entry.parameters;
          } else {
            const clean = validateParametersSchema(patch.parameters, name);
            if (JSON.stringify(clean) === JSON.stringify(canonical.parameters)) delete entry.parameters;
            else entry.parameters = clean;
          }
        }
        if (Object.keys(entry).length === 0) delete tools[name];
        else tools[name] = entry;
      }
    }

    if (input.injections !== undefined) {
      if (!input.injections || typeof input.injections !== 'object' || Array.isArray(input.injections)) {
        throw fault('INVALID_TRANSPARENCY', 'injections must be an object.');
      }
      for (const [key, val] of Object.entries(input.injections)) {
        if (!Object.hasOwn(DEFAULT_INJECTIONS, key)) {
          throw fault('INVALID_TRANSPARENCY', `Unknown injection field "${key}".`);
        }
        if (typeof DEFAULT_INJECTIONS[key] === 'boolean') {
          if (typeof val !== 'boolean') throw fault('INVALID_TRANSPARENCY', `injections.${key} must be a boolean.`);
          injections[key] = val;
        } else {
          if (typeof val !== 'string') throw fault('INVALID_TRANSPARENCY', `injections.${key} must be a string.`);
          if (val.length > 8192) throw fault('INVALID_TRANSPARENCY', `injections.${key} exceeds 8,192 characters.`);
          injections[key] = val;
        }
      }
    }
  }

  return { prompts, tools, injections };
}

export function applyToolOverrides(tools = [], config = null) {
  if (!Array.isArray(tools) || !config?.tools || typeof config.tools !== 'object') return tools;
  const overrides = config.tools;
  if (!Object.keys(overrides).length) return tools;
  const out = [];
  for (const tool of tools) {
    const ov = overrides[tool.name];
    if (!ov) { out.push(tool); continue; }
    if (ov.enabled === false) continue;
    out.push({
      ...tool,
      ...(typeof ov.description === 'string' && ov.description.trim() ? { description: ov.description } : {}),
      ...(ov.parameters && typeof ov.parameters === 'object' ? { parameters: ov.parameters } : {}),
    });
  }
  return out;
}

export function buildPrefillPayload(injections) {
  if (!injections?.enabled) return { rawPrefill: '', assistantPrefill: '', reasoningPrefill: '' };
  const reasoning = typeof injections.reasoningPrefill === 'string' ? injections.reasoningPrefill : '';
  const assistant = typeof injections.assistantPrefill === 'string' ? injections.assistantPrefill : '';
  if (!reasoning && !assistant) return { rawPrefill: '', assistantPrefill: '', reasoningPrefill: '' };
  if (reasoning) {
    const wrapped = /^\s*<think>/i.test(reasoning) ? reasoning : `<think>\n${reasoning}`;
    const rawPrefill = assistant
      ? (/<\/think>/i.test(wrapped) ? `${wrapped}${assistant}` : `${wrapped}\n</think>\n${assistant}`)
      : wrapped;
    return { rawPrefill, assistantPrefill: assistant, reasoningPrefill: reasoning };
  }
  return { rawPrefill: assistant, assistantPrefill: assistant, reasoningPrefill: '' };
}

function wrapUserContent(content, prefix, suffix) {
  if (!prefix && !suffix) return content;
  if (typeof content === 'string') return `${prefix}${content}${suffix}`;
  if (Array.isArray(content)) {
    const cloned = content.map(part => ({ ...part }));
    const idx = cloned.findIndex(part => (part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string');
    if (idx >= 0) {
      cloned[idx].text = `${prefix}${cloned[idx].text}${suffix}`;
      return cloned;
    }
  }
  return content;
}

export function applyMessageInjections(messages, config = null, { allowAssistantPrefill = true } = {}) {
  const inj = config?.injections;
  if (!inj?.enabled || !Array.isArray(messages) || !messages.length) {
    return { messages, rawPrefill: '', assistantPrefill: '', reasoningPrefill: '', stitchPrefill: false };
  }
  const out = messages.map(m => ({ ...m }));
  const lastUserIdx = out.findLastIndex(m => m.role === 'user');
  if (lastUserIdx >= 0) {
    if (inj.userPrefix || inj.userSuffix) {
      out[lastUserIdx] = { ...out[lastUserIdx], content: wrapUserContent(out[lastUserIdx].content, inj.userPrefix || '', inj.userSuffix || '') };
    }
    const hasFewUser = Boolean(inj.fewShotUser && inj.fewShotUser.trim());
    const hasFewAsst = Boolean(inj.fewShotAssistant && inj.fewShotAssistant.trim());
    if (hasFewUser && hasFewAsst) {
      out.splice(lastUserIdx, 0, { role: 'user', content: inj.fewShotUser }, { role: 'assistant', content: inj.fewShotAssistant });
    } else if (hasFewUser) {
      // Avoid consecutive [user, user] messages (rejected by Anthropic Messages API)
      out[lastUserIdx] = { ...out[lastUserIdx], content: wrapUserContent(out[lastUserIdx].content, `${inj.fewShotUser}\n\n`, '') };
    } else if (hasFewAsst && lastUserIdx > 0 && out[lastUserIdx - 1]?.role === 'user') {
      out.splice(lastUserIdx, 0, { role: 'assistant', content: inj.fewShotAssistant });
    }
  }
  const prefill = allowAssistantPrefill ? buildPrefillPayload(inj) : { rawPrefill: '', assistantPrefill: '', reasoningPrefill: '' };
  if (prefill.rawPrefill) {
    if (out.at(-1)?.role === 'assistant') {
      const prev = out[out.length - 1];
      out[out.length - 1] = { ...prev, content: typeof prev.content === 'string' ? `${prev.content}\n\n${prefill.rawPrefill}` : prefill.rawPrefill };
    } else {
      out.push({ role: 'assistant', content: prefill.rawPrefill });
    }
  }
  return {
    messages: out,
    rawPrefill: prefill.rawPrefill,
    assistantPrefill: prefill.assistantPrefill,
    reasoningPrefill: prefill.reasoningPrefill,
    stitchPrefill: inj.stitchPrefill !== false,
  };
}

export function stitchPrefillIntoText(text, { assistantPrefill = '', stitchPrefill = true } = {}) {
  if (!stitchPrefill || !assistantPrefill || typeof text !== 'string') return text;
  if (!text) return assistantPrefill;
  const trimmedPrefix = assistantPrefill.trimStart();
  if (trimmedPrefix && text.trimStart().startsWith(trimmedPrefix)) return text;
  return `${assistantPrefill}${text}`;
}

const VISUAL_PREVIEW_PATTERN = /\b(?:html5?|css|svg|canvas|webgl|three\.?js|web\s*page|webpage|website|landing\s*page|web\s*app|webapp|dashboard|ui\b|ux\b|frontend|front-end|browser\s*game|video\s*game|playable|arcade|tetris|snake|pong|chess|game\b|chart|graph|plot|diagram|mermaid|visualiz\w*|graphic|animation|shader|slide\s*deck|presentation|mockup|prototype|interactive\s+(?:app|demo|sim\w*|tool|page)|preview\s*canvas)\b/i;

export function promptWantsLivePreview(task) {
  if (!task || typeof task !== 'object') return false;
  const parts = [task.objective, ...(Array.isArray(task.followups) ? task.followups.map(f => f?.message) : [])]
    .filter(s => typeof s === 'string' && s.trim());
  if (!parts.length) return false;
  return VISUAL_PREVIEW_PATTERN.test(parts.join('\n'));
}

export function buildCatalogSystemPrompt(context, { enableTools = true } = {}) {
  const transparency = context?.task?.fixtureId ? null : (context?.transparency || null);
  const persona = PERSONAS[resolvePersona(context?.task?.persona)];
  const personaKey = persona.id === 'focused' ? 'personaFocused' : 'personaPlinian';
  const personaText = (transparency?.prompts && Object.hasOwn(transparency.prompts, personaKey))
    ? transparency.prompts[personaKey]
    : persona.instructions;
  const hasCustomPreviewHint = Boolean(transparency?.prompts && Object.hasOwn(transparency.prompts, 'livePreviewHint'));
  const previewHint = hasCustomPreviewHint
    ? transparency.prompts.livePreviewHint
    : (promptWantsLivePreview(context?.task) ? DEFAULT_LIVE_PREVIEW_HINT : '');
  const toolsHeader = (transparency?.prompts && Object.hasOwn(transparency.prompts, 'catalogToolsHeader'))
    ? transparency.prompts.catalogToolsHeader
    : DEFAULT_CATALOG_TOOLS_HEADER;

  let systemContent = [personaText, previewHint].filter(Boolean).join('\n\n');
  if (enableTools && Array.isArray(context?.tools) && context.tools.length) {
    const toolNames = context.tools.map(t => t.name);
    const playbook = buildToolPlaybook(toolNames, { execEnabled: context.task?.execution?.enabled === true, transparency });
    systemContent += `${effortInstructions(context.task?.effort, transparency)}${toolsHeader ? `\n\n${toolsHeader}` : ''}${playbook}`;
  } else if (context?.task?.effort && context.task.effort !== 'medium') {
    systemContent += effortInstructions(context.task.effort, transparency);
  }
  return applySystemEnvelope(systemContent, transparency);
}

export function buildTransparencySnapshot(rawConfig = DEFAULT_TRANSPARENCY_CONFIG, { task = null, activeTools = null } = {}) {
  const config = normalizeTransparencyConfig({}, rawConfig);
  const prompts = SYSTEM_PROMPT_CATALOG.map(spec => {
    const defaultValue = spec.defaultValue();
    const overridden = Object.hasOwn(config.prompts, spec.id);
    const value = overridden ? config.prompts[spec.id] : defaultValue;
    return {
      id: spec.id,
      group: spec.group,
      title: spec.title,
      description: spec.description,
      defaultValue,
      value,
      overridden,
    };
  });
  const tools = TOOLS.map(tool => {
    const ov = config.tools[tool.name] || {};
    const enabled = ov.enabled !== false;
    const description = typeof ov.description === 'string' ? ov.description : tool.description;
    const parameters = ov.parameters || tool.parameters;
    const overridden = Object.keys(ov).length > 0;
    return {
      name: tool.name,
      category: toolCategory(tool.name),
      defaultDescription: tool.description,
      description,
      defaultParameters: tool.parameters,
      parameters,
      resultSchema: tool.result,
      enabled,
      overridden,
    };
  });

  const sampleTask = task || {
    id: 'preview',
    workspaceKind: 'conversation',
    persona: 'plinian',
    effort: 'medium',
    planMode: false,
    execution: { enabled: false, network: false, timeoutMs: 30000 },
    objective: 'Your next message appears here…',
  };
  const effectiveTools = applyToolOverrides(activeTools || TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })), config);
  const previewContext = {
    task: sampleTask,
    files: [],
    tools: effectiveTools,
    memories: [],
    transparency: config,
  };
  const agentSystem = compileInstructions(previewContext);
  const directSystem = buildCatalogSystemPrompt(previewContext, { enableTools: effectiveTools.length > 0 });
  const sampleWire = applyMessageInjections(
    [{ role: 'system', content: directSystem }, { role: 'user', content: sampleTask.objective || 'Your next message appears here…' }],
    config,
    { allowAssistantPrefill: true }
  );

  return {
    prompts,
    tools,
    injections: config.injections,
    presets: INJECTION_PRESETS,
    overrideCount: {
      prompts: Object.keys(config.prompts).length,
      tools: Object.keys(config.tools).length,
      disabledTools: tools.filter(t => !t.enabled).length,
      injectionsActive: Boolean(config.injections.enabled),
    },
    compiledPreview: {
      taskId: task?.id || null,
      taskTitle: task?.title || null,
      directChat: {
        system: directSystem,
        chars: directSystem.length,
        approxTokens: Math.ceil(directSystem.length / 4),
        wireMessages: sampleWire.messages.map(m => ({
          role: m.role,
          preview: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      },
      agentLoop: {
        system: agentSystem,
        chars: agentSystem.length,
        approxTokens: Math.ceil(agentSystem.length / 4),
      },
      activeToolCount: effectiveTools.length,
      activeTools: effectiveTools,
    },
  };
}
