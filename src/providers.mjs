import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TOOLS } from './broker.mjs';
import { resolveCatalogEntry } from './model-catalog.mjs';
import { classifyProviderFailure } from './outcomes.mjs';
import { compilePrompt, compileInstructions, compileTaskContext, buildToolPlaybook, effortInstructions, PROMPT_VERSION, PERSONAS, resolvePersona } from './prompts.mjs';
import { applyMessageInjections, buildCatalogSystemPrompt, stitchPrefillIntoText } from './prompt-transparency.mjs';
import { complianceMessages, ultraPlinianComplianceMessages } from './reframe.mjs';
import { detectRefusal } from './routing.mjs';
import {
  CLI_NO_TELEMETRY_ENV,
  DEFAULT_PRIVACY_SETTINGS,
  applyZdrRequestPolicy,
  checkProviderPrivacyAllowed,
  environmentSecrets,
  extractHost,
  isPrivateLanHost,
  prepareOutboundRequest,
  redactOutboundValue,
  redactOutboundText
} from './privacy.mjs';

export { compilePrompt, compileInstructions, compileTaskContext, inspectPrompt, PROMPT_VERSION, PERSONAS } from './prompts.mjs';

export const canonicalTools = TOOLS;

export function toolAliases(tools = canonicalTools) {
  const forward = new Map(), reverse = new Map();
  for (const tool of tools) {
    const alias = tool.name.replace(/[^a-zA-Z0-9_-]/g, '__');
    const legacyHash = 'g0d_' + createHash('sha256').update(tool.name).digest('hex').slice(0,48);
    if (reverse.has(alias)) throw new Error('Tool alias collision');
    forward.set(tool.name, alias);
    reverse.set(alias, tool.name);
    reverse.set(legacyHash, tool.name);
  }
  return { forward, reverse };
}

export function decisionSchema(tools = canonicalTools) {
  return {
    type: 'object', properties: {
      type: { type: 'string', enum: ['tool', 'message'] },
      calls: { type: 'array', ...(tools.length?{}:{maxItems:0}), items: { type: 'object', properties: {
        id: { type: 'string' }, name: { type: 'string', ...(tools.length?{enum:tools.map(tool=>tool.name)}:{}) }, arguments: { type: 'string' }
      }, required: ['id', 'name', 'arguments'], additionalProperties: false } },
      text: { type: 'string' }, finish: { type: 'string', enum: ['continue', 'done', 'refusal'] }
    }, required: ['type', 'calls', 'text', 'finish'], additionalProperties: false
  };
}

function normalizeCalls(calls, aliases, tools = canonicalTools) {
  if (!Array.isArray(calls) || calls.length > 32) throw Object.assign(new Error('Tool call batch must contain at most 32 calls'), { code: 'tool_protocol' });
  const seen = new Set();
  return calls.map((call) => {
    if (!call || typeof call !== 'object') throw Object.assign(new Error('Invalid tool call'), { code: 'tool_protocol' });
    const name=aliases.reverse.get(call.name)||call.name;
    if (!tools.some(t=>t.name===name)) throw Object.assign(new Error(`Unknown or unadvertised tool ${call.name}`),{code:'tool_protocol'});
    let args;
    try { args=typeof call.arguments==='string'?(call.arguments.trim()?JSON.parse(call.arguments):{}):(call.arguments??call.args??{}); }
    catch { throw Object.assign(new Error('Tool arguments must be valid JSON'), { code: 'tool_protocol' }); }
    if (!args || typeof args!=='object' || Array.isArray(args)) throw Object.assign(new Error('Tool arguments must be an object'),{code:'tool_protocol'});
    const id=call.id||randomUUID();
    if(typeof id!=='string'||id.length>200||seen.has(id))throw Object.assign(new Error('Tool call identifiers must be unique strings of at most 200 characters'),{code:'tool_protocol'});
    seen.add(id);
    const rawExtra = call.extra_content && typeof call.extra_content === 'object' ? call.extra_content
      : call.extraContent && typeof call.extraContent === 'object' ? call.extraContent : null;
    const rawSig = typeof call.thoughtSignature === 'string' && call.thoughtSignature ? call.thoughtSignature
      : typeof call.thought_signature === 'string' && call.thought_signature ? call.thought_signature
        : typeof rawExtra?.google?.thought_signature === 'string' && rawExtra.google.thought_signature ? rawExtra.google.thought_signature : null;
    const thoughtSignature = rawSig ? rawSig.slice(0, 8192) : null;
    const extraContent = thoughtSignature ? { google: { thought_signature: thoughtSignature } } : null;
    return {
      id,
      name,
      args,
      ...(extraContent ? { extra_content: extraContent } : {}),
      ...(thoughtSignature ? { thoughtSignature } : {}),
    };
  });
}

function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
    if (k === 'type' && Array.isArray(v)) {
      const nonNull = v.find(t => t !== 'null') || 'string';
      out.type = nonNull;
      if (v.includes('null')) out.nullable = true;
      continue;
    }
    out[k] = sanitizeSchemaForGemini(v);
  }
  return out;
}

/**
 * Fallback parser for small local models (e.g. Qwen2.5-Coder, Llama 3.1, Hermes on Ollama)
 * that emit tool calls as `<tool_call>{...}</tool_call>` or standalone JSON envelopes in text
 * instead of structured OpenAI `tool_calls`. Strictly validated against advertised tools.
 */
export function extractTextToolCalls(text, aliases, tools = canonicalTools) {
  if (typeof text !== 'string' || !text.trim() || !Array.isArray(tools) || !tools.length) return [];
  const rawEntries = [];
  // Strip markdown fenced code blocks before scanning for XML tool tags so quoted tutorials/docs cannot inject calls.
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');
  const tagRegex = /<(?:tool_call|function_call)\s*>([\s\S]*?)<\/(?:tool_call|function_call)\s*>/gi;
  for (const match of withoutFences.matchAll(tagRegex)) {
    const inner = match[1]?.trim();
    if (!inner) continue;
    try {
      const parsed = JSON.parse(inner);
      if (Array.isArray(parsed)) rawEntries.push(...parsed);
      else if (parsed && typeof parsed === 'object') rawEntries.push(parsed);
    } catch {}
  }
  if (!rawEntries.length) {
    // Also handle a single standalone JSON or ```json fenced tool-call object matching an advertised tool name
    const trimmed = text.trim();
    const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
    const candidate = fence ? fence[1].trim() : trimmed;
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.name === 'string') {
          const resolved = aliases?.reverse?.get(parsed.name) || parsed.name;
          if (tools.some(t => t.name === resolved) && (parsed.arguments !== undefined || parsed.parameters !== undefined || parsed.args !== undefined)) {
            rawEntries.push(parsed);
          }
        }
      } catch {}
    }
  }
  if (!rawEntries.length) return [];
  const shaped = rawEntries
    .filter(item => item && typeof item === 'object' && typeof item.name === 'string')
    .map(item => ({
      id: typeof item.id === 'string' && item.id ? item.id : `txt_tc_${randomUUID()}`,
      name: item.name,
      arguments: item.arguments ?? item.parameters ?? item.args ?? {},
    }));
  if (!shaped.length) return [];
  try {
    return normalizeCalls(shaped, aliases || toolAliases(tools), tools);
  } catch {
    return [];
  }
}

function providerCapabilities(nativeTools, instructionRole) {
  return { tools: true, nativeTools, portableContext: true, nativeToolReplay: false,
    toolNames: canonicalTools.map(tool => tool.name), instructionRole, promptVersion: PROMPT_VERSION };
}

function retryAfterMilliseconds(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const header = value.trim();
  // Keep long server delays intact so the controller can park rather than retry early.
  if (/^\d+(?:\.\d+)?$/.test(header)) {
    const [seconds, fraction = ''] = header.split('.');
    const milliseconds = BigInt(seconds) * 1000n + BigInt(fraction.slice(0, 3).padEnd(3, '0')) + (/[1-9]/.test(fraction.slice(3)) ? 1n : 0n);
    return Number(milliseconds > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : milliseconds);
  }
  // Date.parse alone treats strings such as "-1" as dates, not malformed delays.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day|sday|nesday|rsday|urday)?,? /.test(header) || !/\d{2}:\d{2}:\d{2}/.test(header)) return undefined;
  const deadline = Date.parse(header);
  return Number.isFinite(deadline) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, deadline - Date.now())) : undefined;
}

function outputProfile(requestProfile, initial, maximum) {
  const invalid = () => Object.assign(new Error('Request profile accepts only an integer maxOutputTokens within the declared provider range and optional reasoningCap.'), { code: 'provider_configuration', retryable: false });
  if (requestProfile === undefined) return Object.freeze({ maxOutputTokens: initial });
  if (!requestProfile || typeof requestProfile !== 'object' || Array.isArray(requestProfile)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(requestProfile))
    || Reflect.ownKeys(requestProfile).some(key => key !== 'maxOutputTokens' && key !== 'reasoningCap')) throw invalid();
  const maxOutputTokens = Object.hasOwn(requestProfile, 'maxOutputTokens') ? requestProfile.maxOutputTokens : initial;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < initial || maxOutputTokens > maximum) throw invalid();
  const reasoningCap = Object.hasOwn(requestProfile, 'reasoningCap') ? requestProfile.reasoningCap : undefined;
  if (reasoningCap !== undefined && !['medium', 'low'].includes(reasoningCap)) throw invalid();
  return Object.freeze({ maxOutputTokens, ...(reasoningCap ? { reasoningCap } : {}) });
}

const httpCredentials = new WeakMap();
const cliEnvironments = new WeakMap();

export function patchRequestBody(provider, { objective, files, conversation, newFiles, parameters = {} }) {
  const instruction = 'Propose the requested edits to the supplied files. Return a unified Git patch beginning with diff --git, with small context hunks and repository-relative a/ and b/ paths. The developer will review and apply the patch.';
  return {
    model: provider.model || provider.id,
    ...parameters,
    max_tokens: parameters.max_tokens ?? Math.min(provider.maxOutputTokens, parameterLimits(provider).fields.max_tokens.max),
    messages: [
      { role: 'system', content: newFiles?.length ? instruction + ' For each requested new file, use new file mode 100644 and /dev/null as the old file.' : instruction },
      { role: 'user', content: JSON.stringify({ objective, conversation, files, newFiles }) },
    ],
  };
}

// These are observable worktree events. Keep terminal output and the local command out of chat requests.
function worktreeRecord(type, data) {
  let record;
  switch (type) {
    case 'code.applied':
      record = { event: 'patch applied', provider: data.provider, files: data.files };
      break;
    case 'code.checked':
      record = {
        event: 'worktree check', exitCode: data.exitCode,
        timedOut: data.timedOut === true, cancelled: data.cancelled === true,
      };
      break;
    case 'code.removed':
      record = { event: 'worktree removed' };
      break;
    default:
      return null;
  }
  return 'GodCode worktree record ' + JSON.stringify({ ...record, branch: data.branch });
}

export function catalogMessages(context, { enableTools = false, aliases = null } = {}) {
  let systemContent = buildCatalogSystemPrompt(context, { enableTools });
  const ws = context.task?.workingSummary;
  if (ws && typeof ws === 'object') {
    const handoff = [];
    if (ws.semantic?.goalAndState) handoff.push(`State: ${ws.semantic.goalAndState}`);
    if (ws.semantic?.decisions?.length) handoff.push(`Decisions: ${ws.semantic.decisions.join(' | ')}`);
    if (ws.semantic?.ruledOut?.length) handoff.push(`Ruled out: ${ws.semantic.ruledOut.join(' | ')}`);
    if (ws.semantic?.constraintsAndPrefs?.length) handoff.push(`Constraints/prefs: ${ws.semantic.constraintsAndPrefs.join(' | ')}`);
    if (ws.semantic?.nextStep) handoff.push(`Next step: ${ws.semantic.nextStep}`);
    if (ws.userClarifications?.length) handoff.push(`User clarifications: ${ws.userClarifications.join(' | ')}`);
    if (ws.failedApproaches?.length) handoff.push(`Failed approaches: ${ws.failedApproaches.join(' | ')}`);
    if (ws.modifiedFiles?.length) {
      const formattedFiles = ws.modifiedFiles.map(f => typeof f === 'string' ? f : `${f.path}${f.status ? ` (${f.status})` : ''}`);
      handoff.push(`Modified files: ${formattedFiles.join(', ')}`);
    }
    if (ws.todoProgress?.total > 0) handoff.push(`Checklist: ${ws.todoProgress.done}/${ws.todoProgress.total} done`);
    if (handoff.length) {
      systemContent += `\n\n[Compacted Session Memory — folded prior turns through seq ${ws.compactedBeforeSeq || 0}; continue seamlessly without repeating finished work]\n${handoff.join('\n')}`;
    }
  }
  const metaBrief = context.task?.routing?.metacognition?.compiledBrief;
  if (typeof metaBrief === 'string' && metaBrief.trim() && !context.task?.fixtureId) {
    systemContent += `\n\n${metaBrief.trim().slice(0, 2400)}`;
  }
  const overseerGuide = context.task?.overseerGuidance || context.task?.routing?.overseerGuidance;
  if (typeof overseerGuide === 'string' && overseerGuide.trim()) {
    systemContent += `\n\n[Overseer Supervisory Guidance — follow directly on this turn]\n${overseerGuide.trim().slice(0, 800)}`;
  }
  const messages = [{ role: 'system', content: systemContent }, { role: 'user', content: context.task.objective }];
  // Persisted follow-ups survive compaction. Ledger order resolves turns
  // sharing a millisecond, including an edited message after a rewind.
  const anchors = new Map();
  const toolResultsByCallId = new Map();
  const taskIdPrefix = context.task?.id ? `${context.task.id}:` : '';
  for (const event of context.history || []) {
    if (!event) continue;
    if (event.type === 'user.message' && event.data?.id) anchors.set(event.data.id, event.seq);
    if (event.type === 'user.messages.applied' && Array.isArray(event.data?.ids)) for (const id of event.data.ids) anchors.set(id, event.seq);
    if (event.type === 'conversation.rewound' && event.data?.messageId) anchors.set(event.data.messageId, event.seq);
    if (enableTools && event.type === 'tool.completed' && event.data?.operationId) {
      const opId = String(event.data.operationId);
      const callId = taskIdPrefix && opId.startsWith(taskIdPrefix) ? opId.slice(taskIdPrefix.length) : opId.slice(opId.indexOf(':') + 1);
      if (callId) toolResultsByCallId.set(callId, event.data.result ?? { ok: event.data.status !== 'failed' });
    }
  }
  const turns = (context.task.followups || []).map(item => ({ role: 'user', content: item.message, time: item.appliedAt || item.createdAt, seq:anchors.get(item.id) }));
  const overseerRefusedSeqs = new Set();
  for (let i = 0; i < context.history.length; i++) {
    const ev = context.history[i];
    if ((ev.type === 'overseer.judged' && ev.data?.isRefusal) || (ev.type === 'overseer.audited' && ev.data?.verdict === 'needs_work')) {
      for (let j = i - 1; j >= 0; j--) {
        if (context.history[j].type === 'model.response') {
          overseerRefusedSeqs.add(context.history[j].seq);
          break;
        }
      }
    }
  }
  for (const { type, time, data, seq } of context.history) {
    if (type === 'model.response' && !data.superseded && !overseerRefusedSeqs.has(seq) && data.response?.type === 'message' && data.response.text && data.response.finish !== 'refusal' && data.replyOutcome?.kind !== 'declined' && !data.declined && !detectRefusal(data.response))
      turns.push({ role: 'assistant', content: data.response.text, time, seq });
    if (enableTools && type === 'model.response' && !data.superseded && data.response?.type === 'tool' && Array.isArray(data.response.calls) && data.response.calls.length) {
      const calls = data.response.calls;
      const anyCompleted = calls.some(c => toolResultsByCallId.has(c.id));
      if (anyCompleted) {
        const toolCalls = calls.map(c => ({
          id: c.id,
          type: 'function',
          function: {
            name: aliases?.forward.get(c.name) || c.name.replace(/[^a-zA-Z0-9_-]/g, '__'),
            arguments: JSON.stringify(c.args || {})
          },
          ...(c.extra_content ? { extra_content: c.extra_content }
            : c.thoughtSignature ? { extra_content: { google: { thought_signature: c.thoughtSignature } } } : {}),
        }));
        const toolResponses = calls.map(c => ({
          role: 'tool',
          tool_call_id: c.id,
          content: JSON.stringify(toolResultsByCallId.get(c.id) ?? { ok: false, skipped: true })
        }));
        turns.push({ role: 'assistant', content: data.response.text || null, tool_calls: toolCalls, _toolResponses: toolResponses, time, seq });
      }
    }
    if (type === 'code.intent') turns.push({ role: 'user', content: data.message, time, seq });
    const record = worktreeRecord(type, data);
    if (record) turns.push({ role: 'assistant', content: record, time, seq });
  }
  turns.sort((a, b) => Number.isInteger(a.seq) && Number.isInteger(b.seq)
    ? a.seq - b.seq
    : String(a.time || '').localeCompare(String(b.time || '')) || (a.seq ?? Infinity) - (b.seq ?? Infinity));
  const recentTurns = turns.slice(-30);
  const fullToolCutoff = Math.max(0, recentTurns.length - 6);
  for (let i = 0; i < recentTurns.length; i++) {
    const turn = recentTurns[i];
    if (turn.tool_calls) {
      messages.push({ role: 'assistant', content: turn.content, tool_calls: turn.tool_calls });
      for (const tr of turn._toolResponses || []) {
        if (i < fullToolCutoff && typeof tr.content === 'string' && tr.content.length > 2500) {
          messages.push({ ...tr, content: tr.content.slice(0, 2400) + '… [older tool result truncated; re-read if needed]' });
        } else {
          messages.push(tr);
        }
      }
    } else {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  return messages;
}

const VALID_TIERS = new Set(['local', 'standard', 'frontier']);
export function inferProviderTier({ id, baseUrl, model, tier } = {}) {
  if (tier !== undefined) {
    if (!VALID_TIERS.has(tier)) throw Object.assign(new Error('Provider tier must be local, standard, or frontier.'), { code: 'provider_configuration', retryable: false });
    return tier;
  }
  let host = '';
  try { host = baseUrl ? new URL(baseUrl).hostname.toLowerCase() : ''; } catch {}
  if (['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(host)) return 'local';
  if (/(?:ollama|mlx|vllm|llama\.?cpp|lmstudio)/i.test(`${id || ''} ${baseUrl || ''}`)) return 'local';
  if (/(?:opus|fable[-_.]?5|sonnet[-_.]?(?:4|5)|claude[-_.]?(?:4|5)|claude-3-7|gpt[-_.]?(?:5|6)|astra|gemini[-_.]?(?:2\.5[-_.]?pro|3|4)|grok[-_.]?(?:4|code)|muse[-_.]?spark|\bo3\b|\bo4\b|deepseek[-_.]?(?:r1|v4)|kimi[-_.]?k3|qwen[-_.]?(?:4|3[-_.]?(?:235b|8)))/i.test(String(model || ''))) return 'frontier';
  return 'standard';
}

function formatUserContent(protocol, text, attachments = []) {
  const images = Array.isArray(attachments) ? attachments.filter(a => typeof a?.dataUrl === 'string' && a.dataUrl.startsWith('data:image/')) : [];
  if (!images.length) return text;
  if (protocol === 'anthropic') {
    return [
      ...images.map(img => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.dataUrl.split(',')[1] || '' }
      })),
      { type: 'text', text }
    ];
  }
  if (protocol === 'openai-responses') {
    return [
      ...images.map(img => ({ type: 'input_image', image_url: img.dataUrl })),
      { type: 'input_text', text }
    ];
  }
  return [
    ...images.map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
    { type: 'text', text }
  ];
}

export const AUTO_CONTINUE_PROMPT = 'Continue seamlessly from the exact character where you stopped. Do not repeat any text or code already written, do not add preamble, and close any open code blocks once the full response is complete.';

/**
 * Seamlessly stitches a continuation chunk onto a truncated partial reply,
 * removing accidental repeated opening code fences or tail/head overlap.
 */
export function stitchContinuation(prev, next) {
  const a = String(prev ?? '');
  let b = String(next ?? '');
  if (!a) return b;
  if (!b) return a;
  // If `prev` ended inside an unclosed ``` fence and `next` begins by re-opening a fence (with a language tag), strip the duplicate fence opener without stripping a bare closing ``` fence.
  const fenceCount = (a.match(/^\s*`{3,}/gm) || []).length;
  if (fenceCount % 2 === 1) {
    b = b.replace(/^\s*`{3,}[a-zA-Z0-9_.:-]+\r?\n/, '');
  }
  // Remove exact suffix/prefix overlap (longest match from up to 400 chars down to 8 chars).
  const maxOverlap = Math.min(400, a.length, b.length);
  for (let len = maxOverlap; len >= 8; len--) {
    if (a.endsWith(b.slice(0, len))) {
      return a + b.slice(len);
    }
  }
  // Also handle single-newline boundary overlap (model echoed last line with leading newline).
  const bTrim = b.replace(/^\r?\n/, '');
  if (bTrim.length !== b.length) {
    const maxTrimOverlap = Math.min(400, a.length, bTrim.length);
    for (let len = maxTrimOverlap; len >= 8; len--) {
      if (a.endsWith(bTrim.slice(0, len))) {
        return a + bTrim.slice(len);
      }
    }
  }
  return a + b;
}

export class HttpProvider {
  constructor({id,label,protocol='openai-chat',baseUrl,model,apiKeyEnv,credential,headers={},timeoutMs=60000,maxOutputTokens=5000,maxOutputTokensCeiling=maxOutputTokens,tier,allowPrivateHttp=false}) {
    if(!['openai-chat','openai-responses','anthropic'].includes(protocol))throw new Error('Unsupported provider protocol');
    const endpoint = URL.canParse(baseUrl) ? new URL(baseUrl) : null;
    if (!endpoint || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error('Choose a provider base URL without embedded credentials, query or fragment.');
    if (endpoint.protocol === 'http:' && endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
    const loopback = /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname) || endpoint.hostname === '[::1]';
    const privateLanAllowed = (Boolean(allowPrivateHttp) || process.env.G0D_ALLOW_PRIVATE_HTTP === '1' || process.env.G0D_ALLOW_LAN_HTTP === '1') && isPrivateLanHost(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && (loopback || privateLanAllowed)))
      throw new Error('Remote providers require HTTPS. Local HTTP providers must use a loopback address (or set G0D_ALLOW_PRIVATE_HTTP=1 / register as a Local Model for private Docker/LAN hosts).');
    if(typeof model!=='string'||!model.trim())throw new Error('Provider model is required');
    if(!Number.isInteger(maxOutputTokens)||!Number.isInteger(maxOutputTokensCeiling)||maxOutputTokens<1||maxOutputTokensCeiling>200000||maxOutputTokens>maxOutputTokensCeiling)throw Object.assign(new Error('Provider output tokens must be integers from 1 to 200000, with initial tokens no greater than the declared ceiling.'),{code:'provider_configuration',retryable:false});
    if(credential!==undefined&&(typeof credential!=='string'||!credential.length||credential.length>8192||/[\r\n\0]/.test(credential)))throw Object.assign(new Error('Provider credential is invalid.'),{code:'provider_configuration',retryable:false});
    const resolvedTier = inferProviderTier({ id, baseUrl, model, tier });
    if(credential!==undefined)httpCredentials.set(this,credential);
    Object.assign(this,{id,label:label||id,protocol,model,apiKeyEnv,headers,timeoutMs,tier:resolvedTier});
    const catalogSpec = resolveCatalogEntry({ id, model, baseUrl: endpoint.href });
    this.modelMetadata = {
      contextWindow: catalogSpec?.contextWindow || 128000,
      maxOutput: catalogSpec?.maxOutput || maxOutputTokensCeiling,
      supportsReasoning: Boolean(catalogSpec?.capabilities?.reasoning),
      supportsVision: catalogSpec?.capabilities?.vision !== false,
      supportsFunctionCalling: catalogSpec?.capabilities?.tools !== false,
      pricing: catalogSpec?.pricing || null,
    };
    Object.defineProperty(this, 'baseUrl', { value: endpoint.href.replace(/\/$/, ''), enumerable: true });
    Object.defineProperties(this,{maxOutputTokens:{value:maxOutputTokens,enumerable:true},maxOutputTokensCeiling:{value:maxOutputTokensCeiling,enumerable:true}});
    this.kind='http'; this.available=credential!==undefined||!apiKeyEnv||Boolean(process.env[apiKeyEnv]);
    this.accounting='one recorded HTTP request per turn; no client retries';
    this.capabilities=providerCapabilities(true, protocol==='openai-responses'?'instructions':'system');
    Object.defineProperty(this.capabilities,'outputTokens',{value:Object.freeze({initial:maxOutputTokens,max:maxOutputTokensCeiling}),enumerable:true});
  }
  close() { this.closed=true;this.available=false;httpCredentials.delete(this); }
  cloneWithModel({ id, label, model }) {
    if (this.closed) throw Object.assign(new Error('Provider connection is closed.'), { status: 400 });
    const cred = httpCredentials.get(this);
    return new HttpProvider({
      id,
      label: label || `${model} · ${this.label}`,
      protocol: this.protocol,
      baseUrl: this.baseUrl,
      model,
      ...(cred !== undefined ? { credential: cred } : { apiKeyEnv: this.apiKeyEnv }),
      headers: { ...this.headers },
      timeoutMs: this.timeoutMs,
      maxOutputTokens: this.maxOutputTokens,
      maxOutputTokensCeiling: this.maxOutputTokensCeiling,
    });
  }
  async draft(messages, signal, draftLimit = 4096, parameters = {}, opts = {}) {
    const bound = Math.min(this.maxOutputTokensCeiling || draftLimit, draftLimit);
    if (this.protocol === 'openai-chat') {
      return this.plainChat(
        { id: this.id, label: this.label, model: this.model, protocol: this.protocol, baseUrl: this.baseUrl, tier: this.tier, maxOutputTokens: bound, maxOutputTokensCeiling: this.maxOutputTokensCeiling },
        messages,
        signal,
        { ...parameters, max_tokens: Math.min(parameters?.max_tokens ?? bound, bound) },
        opts
      );
    }
    const privacy = opts.privacy || DEFAULT_PRIVACY_SETTINGS;
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      opts.onOutbound?.({ providerId: this.id, host: extractHost(this.baseUrl), protocol: this.protocol, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.code });
      return { type: 'error', code: gate.code, message: gate.reason };
    }
    const key = httpCredentials.has(this) ? httpCredentials.get(this) : (this.apiKeyEnv ? process.env[this.apiKeyEnv] : undefined);
    if (this.apiKeyEnv && !key) return { type: 'error', code: 'PROVIDER_UNAVAILABLE', message: `Missing ${this.apiKeyEnv}.` };
    const shouldRedact = privacy.redactOutboundSecrets !== false && (!gate.posture.localOnly || gate.posture.skipSecretRedaction === false);
    const secretList = shouldRedact ? (opts.extraSecrets || environmentSecrets()) : [];
    let secretsRedacted = 0;
    const cleanText = (txt) => {
      if (!shouldRedact || typeof txt !== 'string') return String(txt || '');
      const c = redactOutboundText(txt, secretList);
      secretsRedacted += c.count;
      return c.text;
    };
    const list = Array.isArray(messages) ? messages : [];
    const sys = cleanText(list.filter(m => m?.role === 'system').map(m => typeof m.content === 'string' ? m.content : '').filter(Boolean).join('\n\n'));
    const rest = list.filter(m => m?.role !== 'system').map(m => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: cleanText(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || ''))
    }));
    if (!rest.length) rest.push({ role: 'user', content: 'Continue.' });
    const reqTimeout = AbortSignal.timeout(Number.isFinite(opts.turnTimeoutMs) && opts.turnTimeoutMs > 0 ? Math.max(this.timeoutMs, opts.turnTimeoutMs) : this.timeoutMs);
    const reqSignal = (signal && typeof signal === 'object' && 'aborted' in signal) ? AbortSignal.any([signal, reqTimeout]) : reqTimeout;

    if (this.protocol === 'anthropic') {
      const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...this.headers };
      if (key) headers['x-api-key'] = key;
      const body = { model: this.model, max_tokens: bound, ...(sys ? { system: sys } : {}), messages: rest };
      const { zdrFlags } = applyZdrRequestPolicy(this, body, privacy);
      opts.onOutbound?.({ providerId: this.id, host: extractHost(this.baseUrl), protocol: this.protocol, zdrClass: gate.posture.zdrClass, zdrFlags, secretsRedacted, blocked: false });
      const res = await fetch(this.baseUrl + '/messages', { method: 'POST', redirect: 'error', signal: reqSignal, headers, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { type: 'error', code: res.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR', httpStatus: res.status, message: data?.error?.message || `Anthropic HTTP ${res.status}` };
      const text = (data.content || []).filter(b => b?.type === 'text').map(b => b.text).join('').trim();
      const finish = data.stop_reason === 'max_tokens' ? 'length' : data.stop_reason === 'refusal' ? 'refusal' : 'done';
      return { type: 'message', text, finish, usage: data.usage || undefined };
    }

    if (this.protocol === 'openai-responses') {
      const headers = { 'content-type': 'application/json', ...this.headers };
      if (key) headers.authorization = 'Bearer ' + key;
      const body = {
        model: this.model,
        max_output_tokens: bound,
        ...(sys ? { instructions: sys } : {}),
        input: rest.map(m => ({ role: m.role, content: m.content }))
      };
      const { zdrFlags } = applyZdrRequestPolicy(this, body, privacy);
      opts.onOutbound?.({ providerId: this.id, host: extractHost(this.baseUrl), protocol: this.protocol, zdrClass: gate.posture.zdrClass, zdrFlags, secretsRedacted, blocked: false });
      const res = await fetch(this.baseUrl + '/responses', { method: 'POST', redirect: 'error', signal: reqSignal, headers, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { type: 'error', code: res.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR', httpStatus: res.status, message: data?.error?.message || `OpenAI Responses HTTP ${res.status}` };
      const text = (typeof data.output_text === 'string' && data.output_text)
        || (data.output || []).flatMap(item => item?.content || []).filter(c => c?.type === 'output_text' || c?.type === 'text').map(c => c.text).join('').trim();
      const finish = data.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'done';
      return { type: 'message', text, finish, usage: data.usage || undefined };
    }

    return { type: 'error', code: 'UNSUPPORTED_PROTOCOL', message: `Drafting is not supported for protocol ${this.protocol}.` };
  }
  continueDraft(messages, partialText, signal, draftLimit = 8192, parameters = {}, opts = {}) {
    if (this.protocol !== 'openai-chat') return this.draft([...(messages || []), { role: 'assistant', content: partialText }, { role: 'user', content: AUTO_CONTINUE_PROMPT }], signal, draftLimit, parameters, opts);
    const boosted = Math.min(this.maxOutputTokensCeiling || 32768, Math.max(draftLimit, 24576));
    const contMessages = [...messages, { role: 'assistant', content: partialText }, { role: 'user', content: AUTO_CONTINUE_PROMPT }];
    return this.plainChat(
      { id: this.id, label: this.label, model: this.model, protocol: this.protocol, baseUrl: this.baseUrl, tier: this.tier, maxOutputTokens: boosted, maxOutputTokensCeiling: this.maxOutputTokensCeiling },
      contMessages,
      signal,
      { ...parameters, max_tokens: Math.min(parameters?.max_tokens ?? boosted, boosted) },
      opts
    );
  }
  catalogChoice({ id, label, model, limit, supportsReasoning = false, supportsFunctionCalling = false, modelMetadata }) {
    const reasoningFloor = supportsReasoning ? Math.max(this.maxOutputTokens, 16384) : this.maxOutputTokens;
    const initialTokens = Math.min(limit, reasoningFloor);
    const choice = { id, label, model, maxOutputTokens: initialTokens, maxOutputTokensCeiling: limit,
      supportsReasoning: Boolean(supportsReasoning),
      supportsFunctionCalling: Boolean(supportsFunctionCalling),
      protocol: this.protocol, baseUrl: this.baseUrl, available: this.available, kind: 'catalog', directChat: true, modelMetadata,
      capabilities: { tools: Boolean(supportsFunctionCalling), outputTokens: Object.freeze({ initial: initialTokens, max: limit }), reasoning: Boolean(supportsReasoning) } };
    choice.draft = (messages, signal, draftLimit, parameters = {}, opts = {}) => {
      const bound = Math.min(choice.maxOutputTokensCeiling || draftLimit, draftLimit);
      return this.plainChat({ ...choice, maxOutputTokens: bound }, messages, signal, { ...parameters, max_tokens: Math.min(parameters.max_tokens ?? bound, bound) }, opts);
    };
    choice.continueDraft = (messages, partialText, signal, draftLimit, parameters = {}, opts = {}) => {
      const boosted = Math.min(choice.maxOutputTokensCeiling || 32768, Math.max(draftLimit, 24576));
      const contMessages = [...messages, { role: 'assistant', content: partialText }, { role: 'user', content: AUTO_CONTINUE_PROMPT }];
      return this.plainChat({ ...choice, maxOutputTokens: boosted }, contMessages, signal, { ...parameters, max_tokens: Math.min(parameters.max_tokens ?? boosted, boosted) }, opts);
    };
    choice.continueChat = (context, partialText, signal, opts = {}) => {
      const msgs = catalogMessages(context);
      const attachments = context.task?.attachments;
      if (Array.isArray(attachments) && attachments.length && msgs.length) {
        const lastIdx = msgs.findLastIndex(m => m.role === 'user' && typeof m.content === 'string');
        if (lastIdx >= 0) msgs[lastIdx] = { ...msgs[lastIdx], content: formatUserContent('openai-chat', msgs[lastIdx].content, attachments) };
      }
      const contMessages = [...msgs, { role: 'assistant', content: partialText }, { role: 'user', content: AUTO_CONTINUE_PROMPT }];
      const boosted = Math.min(choice.maxOutputTokensCeiling || 65536, Math.max(choice.maxOutputTokens * 2, 32768));
      return this.plainChat({ ...choice, maxOutputTokens: boosted }, contMessages, signal, context.task.generation, opts);
    };
    choice.proposePatch = (input, opts) => this.proposePatch(input, opts, choice);
    choice.turn = (context, opts = {}) => this.catalogChat(choice, context, opts.signal, opts);
    return choice;
  }
  async catalogChat(choice, context, signal, opts = {}) {
    const effort = String(context.task?.effort || 'medium').toLowerCase();
    const escalated = opts.requestProfile?.maxOutputTokens;
    const reasoningCap = opts.requestProfile?.reasoningCap;
    const effortCeiling = choice.maxOutputTokensCeiling
      ? (effort === 'max'
          ? Math.min(choice.maxOutputTokensCeiling, Math.max(choice.maxOutputTokens, 65536))
          : effort === 'high'
            ? Math.min(choice.maxOutputTokensCeiling, Math.max(choice.maxOutputTokens, 32768))
            : choice.maxOutputTokens)
      : choice.maxOutputTokens;
    const targetTokens = Number.isInteger(escalated) && escalated > effortCeiling
      ? Math.min(escalated, choice.maxOutputTokensCeiling || escalated)
      : effortCeiling;
    const effectiveChoice = targetTokens !== choice.maxOutputTokens
      ? { ...choice, maxOutputTokens: targetTokens }
      : choice;
    const rawTools = choice.supportsFunctionCalling && Array.isArray(context.tools) && context.tools.length
      ? context.tools.filter(t => (context.task?.execution?.enabled === true || t.name !== 'process.run')
        && !(effort === 'fast' && context.task?.workspaceKind === 'conversation' && !context.task?.sourcePath && (t.name === 'task.todo' || t.name === 'agent.spawn')))
      : null;
    const tools = rawTools?.length ? rawTools : null;
    const aliases = tools ? toolAliases(tools) : null;
    const msgs = catalogMessages(tools ? { ...context, tools } : context, { enableTools: Boolean(tools), aliases });
    const attachments = context.task?.attachments;
    if (Array.isArray(attachments) && attachments.length && msgs.length) {
      const lastIdx = msgs.findLastIndex(m => m.role === 'user' && typeof m.content === 'string');
      if (lastIdx >= 0) msgs[lastIdx] = { ...msgs[lastIdx], content: formatUserContent('openai-chat', msgs[lastIdx].content, attachments) };
    }
    const injected = applyMessageInjections(msgs, context.task?.fixtureId ? null : context.transparency, { allowAssistantPrefill: true });
    const baseReasoningEffort = choice.supportsReasoning
      ? (effort === 'fast' ? 'low' : effort === 'high' || effort === 'max' ? 'high' : undefined)
      : undefined;
    const reasoningEffort = !choice.supportsReasoning
      ? undefined
      : reasoningCap === 'low'
        ? 'low'
        : reasoningCap === 'medium'
          ? undefined
          : baseReasoningEffort;
    return this.plainChat(effectiveChoice, injected.messages, signal, context.task.generation, { ...opts, ...(tools ? { tools, aliases } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(injected.rawPrefill ? { prefill: injected } : {}) });
  }
  async plainChat(choice, messages, signal, input = {}, opts = {}) {
    if (this.closed) return { type: 'error', code: 'provider_configuration', message: 'Provider is closed.', retryable: false };
    const privacy = opts.privacy || DEFAULT_PRIVACY_SETTINGS;
    const gate = checkProviderPrivacyAllowed(choice, privacy);
    if (!gate.allowed) {
      opts.onOutbound?.({ providerId: choice.id, host: extractHost(choice.baseUrl), protocol: choice.protocol, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const parameters = parametersFor(choice, input);
    const key = httpCredentials.get(this) ?? (this.apiKeyEnv ? process.env[this.apiKeyEnv] : null);
    const headers = { 'content-type': 'application/json', ...this.headers };
    if (key) headers.authorization = 'Bearer ' + key;
    let secretsRedacted = 0;
    const shouldRedact = privacy.redactOutboundSecrets !== false && (!gate.posture.localOnly || gate.posture.skipSecretRedaction === false);
    const secretList = shouldRedact ? (opts.extraSecrets || environmentSecrets()) : [];
    const isGeminiModel = /gemini/i.test(choice.model || choice.id || '');
    const outgoingMessages = messages.map(m => {
      let next = m;
      if (Array.isArray(next?.tool_calls)) {
        const mappedCalls = next.tool_calls.map(tc => {
          let c = tc;
          if (!isGeminiModel && c?.extra_content) {
            const { extra_content: _drop, ...restCall } = c;
            c = restCall;
          }
          if (shouldRedact && c?.function?.arguments) {
            const cleaned = redactOutboundText(String(c.function.arguments), secretList);
            if (cleaned.count) {
              secretsRedacted += cleaned.count;
              c = { ...c, function: { ...c.function, arguments: cleaned.text } };
            }
          }
          return c;
        });
        next = { ...next, tool_calls: mappedCalls };
      }
      if (!shouldRedact) return next;
      if (typeof next?.content === 'string') {
        const cleaned = redactOutboundText(next.content, secretList);
        secretsRedacted += cleaned.count;
        return cleaned.count ? { ...next, content: cleaned.text } : next;
      }
      if (Array.isArray(next?.content)) {
        let changed = false;
        const nextParts = next.content.map(part => {
          if (part && part.type === 'text' && typeof part.text === 'string') {
            const cleaned = redactOutboundText(part.text, secretList);
            if (cleaned.count) { secretsRedacted += cleaned.count; changed = true; return { ...part, text: cleaned.text }; }
          }
          return part;
        });
        return changed ? { ...next, content: nextParts } : next;
      }
      return next;
    });
    const activeTools = Array.isArray(opts.tools) && opts.tools.length ? opts.tools : null;
    const aliases = activeTools ? (opts.aliases || toolAliases(activeTools)) : null;
    const wantsStream = typeof opts.onDelta === 'function';
    const body = {
      model: choice.model,
      messages: outgoingMessages,
      max_tokens: choice.maxOutputTokens,
      ...parameters,
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      ...(activeTools ? {
        tools: activeTools.map(t => ({
          type: 'function',
          function: {
            name: aliases.forward.get(t.name),
            description: t.description,
            parameters: isGeminiModel ? sanitizeSchemaForGemini(t.parameters) : t.parameters
          }
        }))
      } : {}),
      ...(wantsStream ? { stream: true, stream_options: { include_usage: true } } : {})
    };
    const { zdrFlags } = applyZdrRequestPolicy(choice, body, privacy);
    opts.onOutbound?.({ providerId: choice.id, host: extractHost(choice.baseUrl), protocol: choice.protocol, zdrClass: gate.posture.zdrClass, zdrFlags, secretsRedacted, blocked: false });
    const reqTimeout = AbortSignal.timeout(Number.isFinite(opts.turnTimeoutMs) && opts.turnTimeoutMs > 0 ? Math.max(this.timeoutMs, opts.turnTimeoutMs) : this.timeoutMs);
    const reqSignal = (signal && typeof signal === 'object' && 'aborted' in signal) ? AbortSignal.any([signal, reqTimeout]) : reqTimeout;
    let res = await fetch(this.baseUrl + '/chat/completions', {
      method: 'POST', redirect: 'error', signal: reqSignal, headers,
      body: JSON.stringify(body),
    });
    // Surgical HTTP 400 fallback:
    // Pass 1: strip optional hints (reasoning_effort, stream_options, prefill) while KEEPING tools intact.
    // Pass 2: only strip tools if the model still returns HTTP 400.
    let prefillUsed = opts.prefill || null;
    let toolsActiveForParse = activeTools;
    let currentBody = body;
    if (res.status === 400 && (currentBody.reasoning_effort || currentBody.stream_options || prefillUsed?.rawPrefill)) {
      res.body?.cancel?.().catch(() => {});
      let nextMsgs = [...outgoingMessages];
      if (prefillUsed?.rawPrefill && nextMsgs.length && nextMsgs[nextMsgs.length - 1]?.role === 'assistant') {
        nextMsgs = nextMsgs.slice(0, -1);
        prefillUsed = null;
      }
      const step1 = { ...currentBody, messages: nextMsgs };
      delete step1.reasoning_effort;
      delete step1.stream_options;
      currentBody = step1;
      res = await fetch(this.baseUrl + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: reqSignal, headers,
        body: JSON.stringify(currentBody),
      });
    }
    if (res.status === 400 && toolsActiveForParse) {
      res.body?.cancel?.().catch(() => {});
      const plainMsgs = currentBody.messages.filter(m => m.role !== 'tool' && !m.tool_calls);
      const step2 = { ...currentBody, messages: plainMsgs };
      delete step2.tools;
      toolsActiveForParse = null;
      currentBody = step2;
      res = await fetch(this.baseUrl + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: reqSignal, headers,
        body: JSON.stringify(currentBody),
      });
    }
    const isVenice = choice.kind === 'catalog' || choice.baseUrl === 'https://api.venice.ai/api/v1' || String(choice.id || '').startsWith('venice:');
    const providerDisplay = isVenice ? 'Venice' : (choice.label || choice.id || 'Provider');
    if (!res.ok) {
      res.body?.cancel?.().catch(() => {});
      // An explicit wait applies to the connection. Only gateway outages qualify for the optional backup.
      const gateway = [502, 503, 504].includes(res.status);
      const wait = res.headers.get('retry-after');
      let code = 'PROVIDER_FAILURE';
      let retryable;
      if (isVenice) {
        if (res.status === 429) code = 'VENICE_RATE_LIMIT';
        else if (res.status === 402) code = 'http_402';
        else if (res.status >= 500 && wait !== null) code = 'VENICE_RETRY_AFTER';
        else if (gateway) code = 'VENICE_SERVICE_OUTAGE';
      } else {
        if (res.status === 401 || res.status === 403) { code = 'authentication'; retryable = false; }
        else if (res.status === 429) { code = 'rate_limit'; retryable = true; }
        else if (res.status === 402) { code = 'http_402'; retryable = false; }
        else if (res.status >= 500) { code = 'provider_unavailable'; retryable = true; }
      }
      const retryAfterMs = (res.status === 429 || (res.status >= 500 && wait !== null)) ? retryAfterMilliseconds(wait) : undefined;
      return { type: 'error', code, httpStatus: res.status, message: `${providerDisplay} returned HTTP ${res.status}.`,
        ...(retryable !== undefined ? { retryable } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    const contentType = (res.headers?.get('content-type') || '').toLowerCase();
    let answer;
    if (currentBody.stream && res.body && !contentType.includes('application/json')) {
      let sText = '', sThinking = '', sRefusal = '', sFinish = null, sError = null, sBytes = 0, lineBuf = '', lastToolIdx = 0;
      const toolAccum = new Map();
      const decoder = new TextDecoder();
      const MAX_STREAM_THINKING = 24000;
      const scrubKey = s => (key && typeof s === 'string' ? s.split(key).join('[redacted credential]') : s);
      const processLine = rawLine => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let parsed;
        try { parsed = JSON.parse(payload); } catch { return; }
        if (parsed.error) { sError = parsed.error; return; }
        const ch = parsed.choices?.[0];
        if (ch?.finish_reason) sFinish = ch.finish_reason;
        const delta = ch?.delta;
        if (!delta) return;
        const rDelta = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
          : typeof delta.reasoning === 'string' ? delta.reasoning : '';
        if (rDelta) {
          const cleanR = scrubKey(rDelta);
          if (sThinking.length < MAX_STREAM_THINKING) sThinking = (sThinking + cleanR).slice(0, MAX_STREAM_THINKING);
          try { opts.onDelta?.({ type: 'thinking', text: cleanR }); } catch {}
        }
        if (typeof delta.content === 'string' && delta.content) {
          const cleanC = scrubKey(delta.content);
          sText += cleanC;
          try { opts.onDelta?.({ type: 'text', text: cleanC }); } catch {}
        }
        if (typeof delta.refusal === 'string' && delta.refusal) sRefusal += delta.refusal;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            let idx;
            if (tc.id) {
              const existing = [...toolAccum.entries()].find(([, v]) => v.id === tc.id);
              if (existing) idx = existing[0];
              else if (Number.isInteger(tc.index) && (!toolAccum.has(tc.index) || !toolAccum.get(tc.index).id)) idx = tc.index;
              else idx = Math.max(-1, ...toolAccum.keys()) + 1;
            } else if (Number.isInteger(tc.index)) {
              idx = tc.index;
            } else {
              idx = lastToolIdx;
            }
            lastToolIdx = idx;
            if (!toolAccum.has(idx)) toolAccum.set(idx, { id: '', function: { name: '', arguments: '' } });
            const acc = toolAccum.get(idx);
            if (tc.id && !acc.id) acc.id = tc.id;
            if (tc.extra_content?.google?.thought_signature) {
              acc.extra_content = { google: { thought_signature: String(tc.extra_content.google.thought_signature).slice(0, 8192) } };
            }
            if (typeof tc.thought_signature === 'string' && tc.thought_signature) {
              acc.thought_signature = tc.thought_signature.slice(0, 8192);
            }
            if (tc.function?.name) acc.function.name += tc.function.name;
            if (tc.function?.arguments != null) {
              acc.function.arguments += typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments);
            }
          }
        }
      };
      for await (const chunk of res.body) {
        sBytes += chunk.byteLength;
        if (sBytes > 32 * 1024 * 1024) {
          res.body?.cancel?.().catch(() => {});
          return { type: 'error', code: 'tool_protocol', httpStatus: res.status, message: 'Venice streaming response exceeded 32 MiB.' };
        }
        lineBuf += decoder.decode(chunk, { stream: true });
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const line of lines) processLine(line);
      }
      lineBuf += decoder.decode();
      if (lineBuf.trim()) for (const line of lineBuf.split('\n')) processLine(line);
      if (sError) {
        return { type: 'error', code: String(sError.code || 'PROVIDER_FAILURE'), httpStatus: res.status, message: scrubKey(String(sError.message || 'Streaming error from provider.')).slice(0, 1000) };
      }
      const assembledCalls = [...toolAccum.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      if (assembledCalls.length && (!sFinish || sFinish === 'length')) {
        return { type: 'error', code: sFinish === 'length' ? 'VENICE_OUTPUT_LIMIT' : 'provider_incomplete', httpStatus: res.status, retryable: sFinish !== 'length', message: 'Streaming tool call ended before completion; no tool calls were executed.', ...(sThinking ? { thinking: sThinking } : {}) };
      }
      if (!sFinish && !sRefusal) {
        return { type: 'error', code: 'provider_incomplete', httpStatus: res.status, retryable: true, message: 'Streaming response ended before a finish reason arrived.', ...(sThinking ? { thinking: sThinking } : {}) };
      }
      answer = {
        finish_reason: sFinish,
        message: {
          content: sText || null,
          ...(sRefusal ? { refusal: sRefusal } : {}),
          ...(sThinking ? { reasoning_content: sThinking } : {}),
          ...(assembledCalls.length ? { tool_calls: assembledCalls } : {}),
        },
      };
    } else {
      try {
        if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
          const chunks = []; let bCount = 0;
          for await (const chunk of res.body) {
            bCount += chunk.byteLength;
            if (bCount > 8 * 1024 * 1024) { res.body?.cancel?.().catch(() => {}); return { type: 'error', code: 'tool_protocol', httpStatus: res.status, message: 'Venice response exceeded 8 MiB.' }; }
            chunks.push(chunk);
          }
          answer = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.choices?.[0];
        } else {
          answer = (await res.json())?.choices?.[0];
        }
      } catch (cause) {
        if (!(cause instanceof SyntaxError)) throw cause;
        return { type: 'error', code: 'PROVIDER_FAILURE', httpStatus: res.status, message: 'Venice returned an unreadable response.' };
      }
    }
    const declined = Boolean(answer?.message?.refusal) || answer?.finish_reason === 'content_filter';
    const rawThinking = typeof answer?.message?.reasoning_content === 'string'
      ? answer.message.reasoning_content.trim()
      : typeof answer?.message?.reasoning === 'string'
        ? answer.message.reasoning.trim()
        : '';
    const cleanThinking = rawThinking ? (key ? rawThinking.split(key).join('[redacted credential]') : rawThinking) : '';
    const rawToolCalls = toolsActiveForParse && !declined && answer?.finish_reason !== 'length' && Array.isArray(answer?.message?.tool_calls)
      ? answer.message.tool_calls.map(tc => ({
        id: tc?.id,
        name: tc?.function?.name,
        arguments: tc?.function?.arguments,
        ...(tc?.extra_content ? { extra_content: tc.extra_content } : {}),
        ...(tc?.thought_signature ? { thought_signature: tc.thought_signature } : {}),
      }))
      : [];
    if (rawToolCalls.length > 0) {
      try {
        const calls = normalizeCalls(rawToolCalls, aliases, toolsActiveForParse);
        const rawText = typeof answer?.message?.content === 'string' && answer.message.content.trim()
          ? (key ? answer.message.content.split(key).join('[redacted credential]') : answer.message.content)
          : '';
        return {
          type: 'tool',
          httpStatus: res.status,
          calls,
          ...(rawText ? { text: rawText } : {}),
          ...(cleanThinking ? { thinking: cleanThinking } : {})
        };
      } catch (err) {
        if (typeof answer?.message?.content !== 'string' || !answer.message.content.trim()) {
          return { type: 'error', httpStatus: res.status, code: err.code || 'tool_protocol', message: err.message || 'Malformed tool call from Venice.' };
        }
      }
    }
    const content = answer?.message?.refusal || answer?.message?.content || (declined && `${providerDisplay} declined this request.`);
    const limited = !declined && answer?.finish_reason === 'length';
    if (typeof content !== 'string' || !content.trim()) return { type: 'error', httpStatus: res.status,
      code: limited ? (isVenice ? 'VENICE_OUTPUT_LIMIT' : 'output_limit') : 'PROVIDER_FAILURE',
      message: limited
        ? (rawThinking
          ? `${providerDisplay} spent its output token limit on internal reasoning before returning visible text.`
          : `${providerDisplay} reached its output limit before returning visible text.`)
        : `${providerDisplay} returned no reply text.`,
      ...(limited && rawThinking ? { exhaustedReasoning: true } : {}) };
    const rawCleanText = key ? content.split(key).join('[redacted credential]') : content;
    const cleanText = !declined && prefillUsed ? stitchPrefillIntoText(rawCleanText, prefillUsed) : rawCleanText;
    return { type: 'message', httpStatus: res.status, text: cleanText,
      ...(cleanThinking ? { thinking: cleanThinking } : {}),
      finish: declined ? 'refusal' : limited ? 'length' : 'done' };
  }
  async proposePatch(input, opts = {}, selected = this) {
    parametersFor(selected, input.parameters);
    const { signal } = input;
    if (input.parameters?.max_tokens > selected.maxOutputTokensCeiling)
      throw new Error('Max output tokens exceeds this model’s configured ceiling of ' + selected.maxOutputTokensCeiling + '.');
    if (this.closed || !this.available || this.protocol !== 'openai-chat') throw new Error('This model is unavailable for patch proposals.');
    const body = prepareOutboundRequest(selected, patchRequestBody(selected, input), opts);
    const key = httpCredentials.get(this) ?? (this.apiKeyEnv ? process.env[this.apiKeyEnv] : null);
    const headers = { 'content-type':'application/json', ...this.headers };
    if (key) headers.authorization = 'Bearer ' + key;
    const result = await fetch(this.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method:'POST', headers, redirect:'error', signal:AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      body:JSON.stringify(body),
    });
    if (!result.ok) {
      await result.body?.cancel?.().catch(() => {});
      throw new Error('Model returned HTTP ' + result.status + '. Check model support for the selected parameters.');
    }
    let message = (await result.json()).choices?.[0]?.message?.content;
    if (typeof message !== 'string') throw new Error('The model returned no text patch.');
    if (!message.trimStart().startsWith('diff --git ')) {
      const blocks = [...message.matchAll(/^```([^\r\n]*)\r?\n([\s\S]*?)^```[\t ]*\r?$/gm)];
      if (blocks.length === 1 && /^(?:diff|patch)?[\t ]*$/.test(blocks[0][1]) &&
          blocks[0][2].trimStart().startsWith('diff --git ')) {
        message = blocks[0][2];
      }
    }
    return message.replace(/^\s*(?=diff --git )/, '').replace(/\r?\n```\s*$/, '').replace(/\n?$/, '\n');
  }
  async turn(context,{signal,requestProfile,onDelta,turnTimeoutMs,privacy=DEFAULT_PRIVACY_SETTINGS,onOutbound,extraSecrets}={}) {
    if(this.closed)return {type:'error',code:'provider_configuration',message:'Provider is closed.',retryable:false};
    if(signal?.aborted)throw signal.reason||Object.assign(new Error('Provider request cancelled'),{code:'cancelled'});
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: extractHost(this.baseUrl), protocol: this.protocol, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const profile=outputProfile(requestProfile,this.maxOutputTokens,this.maxOutputTokensCeiling);
    const generation=parametersFor(this,context.task?.generation);
    const taskEffortForTokens = String(context.task?.effort || 'medium').toLowerCase();
    const effortTokenFloor = this.maxOutputTokensCeiling
      ? (taskEffortForTokens === 'max' ? Math.min(this.maxOutputTokensCeiling, 64000)
        : taskEffortForTokens === 'high' ? Math.min(this.maxOutputTokensCeiling, 32768) : 0)
      : 0;
    const targetOutputTokens = Math.max(profile.maxOutputTokens, effortTokenFloor);
    const maxOutputTokens=Math.min(targetOutputTokens,parameterLimits(this).fields.max_tokens.max);
    if(!this.available) return {type:'error',code:'authentication',message:`Set ${this.apiKeyEnv} in the server environment.`,retryable:false};
    const tools=context.tools??canonicalTools, aliases=toolAliases(tools);
    let prompt=compileTaskContext({...context,tools});
    let instructions=compileInstructions(context);
    let secretsRedacted = 0;
    const shouldRedactTurn = !gate.posture.skipSecretRedaction && privacy?.redactOutboundSecrets !== false;
    const turnSecrets = shouldRedactTurn ? (extraSecrets || environmentSecrets()) : [];
    if (shouldRedactTurn) {
      const cleaned = redactOutboundValue([prompt, instructions], turnSecrets);
      [prompt, instructions] = cleaned.value;
      secretsRedacted = cleaned.count;
    }
    const redactInjected = msgs => {
      if (!shouldRedactTurn) return msgs;
      const cleaned = redactOutboundValue(msgs, turnSecrets);
      secretsRedacted += cleaned.count;
      return cleaned.value;
    };
    const headers={'content-type':'application/json',...this.headers};
    const key=httpCredentials.get(this)??(this.apiKeyEnv?process.env[this.apiKeyEnv]:null);
    let endpoint,body;
    const userAttachments = Array.isArray(context.task?.attachments) ? context.task.attachments : [];
    const visualObs = this.modelMetadata?.supportsVision !== false && Array.isArray(context.visualObservations) ? context.visualObservations : [];
    const attachments = visualObs.length ? [...userAttachments, ...visualObs] : userAttachments;
    const isGeminiWire = /generativelanguage\.googleapis\.com/i.test(this.baseUrl) || /gemini/i.test(String(this.model || ''));
    const toolParamsForWire = params => (isGeminiWire ? sanitizeSchemaForGemini(params) : params);
    const transparency = context.task?.fixtureId ? null : (context.transparency || null);
    let prefillMeta = null;
    const isFixtureTask = Boolean(context.task?.fixtureId);
    if(this.protocol==='anthropic') {
      endpoint=this.baseUrl.replace(/\/$/,'')+'/messages';
      if(key)headers['x-api-key']=key; headers['anthropic-version']='2023-06-01';
      const getCompliance = context.task?.ultraplinian ? ultraPlinianComplianceMessages : complianceMessages;
      const priorComplianceA = isFixtureTask ? getCompliance(context.task?.recoveries) : [];
      const anthropicTools = tools.map(t=>({name:aliases.forward.get(t.name),description:t.description,input_schema:t.parameters}));
      if(anthropicTools.length>0) anthropicTools[anthropicTools.length-1].cache_control={type:'ephemeral'};
      const injectedA = applyMessageInjections([...priorComplianceA,{role:'user',content:formatUserContent('anthropic', prompt, attachments)}], transparency, { allowAssistantPrefill: true });
      prefillMeta = injectedA.rawPrefill ? injectedA : null;
      body={model:this.model,max_tokens:maxOutputTokens,system:[{type:'text',text:instructions,cache_control:{type:'ephemeral'}}],messages:redactInjected(injectedA.messages),tools:anthropicTools};
    } else if(this.protocol==='openai-responses') {
      endpoint=this.baseUrl.replace(/\/$/,'')+'/responses'; if(key)headers.authorization=`Bearer ${key}`;
      const getComplianceR = context.task?.ultraplinian ? ultraPlinianComplianceMessages : complianceMessages;
      const priorComplianceR = isFixtureTask ? getComplianceR(context.task?.recoveries) : [];
      const injectedR = applyMessageInjections([...priorComplianceR,{role:'user',content:formatUserContent('openai-responses', prompt, attachments)}], transparency, { allowAssistantPrefill: true });
      prefillMeta = injectedR.rawPrefill ? injectedR : null;
      body={model:this.model,instructions,input:redactInjected(injectedR.messages),max_output_tokens:maxOutputTokens,store:false,tools:tools.map(t=>({type:'function',name:aliases.forward.get(t.name),description:t.description,parameters:t.parameters,strict:false}))};
    } else {
      endpoint=this.baseUrl.replace(/\/$/,'')+'/chat/completions'; if(key)headers.authorization=`Bearer ${key}`;
      const getComplianceC = context.task?.ultraplinian ? ultraPlinianComplianceMessages : complianceMessages;
      const priorCompliance = isFixtureTask ? getComplianceC(context.task?.recoveries) : [];
      const injectedC = applyMessageInjections([{role:'system',content:instructions},...priorCompliance,{role:'user',content:formatUserContent('openai-chat', prompt, attachments)}], transparency, { allowAssistantPrefill: true });
      prefillMeta = injectedC.rawPrefill ? injectedC : null;
      body={model:this.model,messages:redactInjected(injectedC.messages),max_tokens:maxOutputTokens,...(tools.length?{tools:tools.map(t=>({type:'function',function:{name:aliases.forward.get(t.name),description:t.description,parameters:toolParamsForWire(t.parameters)}}))}:{})};
    }
    Object.assign(body,generation);
    if (this.protocol === 'openai-responses' && Object.hasOwn(generation, 'max_tokens')) {
      body.max_output_tokens = generation.max_tokens;
      delete body.max_tokens;
    }
    const taskEffort = String(context.task?.effort || 'medium').toLowerCase();
    const isReasoningModel = Boolean(this.modelMetadata?.supportsReasoning) || /(?:o1|o3|o4|gpt-5|gpt-6|gemini[-_.]?(?:2\.5|3|4)|deepseek-r1|qwq|thinking|reasoning)/i.test(String(this.model || ''));
    if (isReasoningModel && taskEffort !== 'medium') {
      const baseApiEffort = taskEffort === 'fast' ? 'low' : 'high';
      const apiEffort = profile.reasoningCap === 'low' ? 'low' : profile.reasoningCap === 'medium' ? null : baseApiEffort;
      if (apiEffort) {
        if (this.protocol === 'openai-responses' && !body.reasoning) body.reasoning = { effort: apiEffort };
        else if (this.protocol === 'openai-chat' && !body.reasoning_effort) body.reasoning_effort = apiEffort;
      }
    }
    const { zdrFlags } = applyZdrRequestPolicy(this, body, privacy);
    if(onDelta){
      body.stream=true;
      if(this.protocol==='openai-chat') body.stream_options={include_usage:true};
    }
    onOutbound?.({ providerId: this.id, host: extractHost(this.baseUrl), protocol: this.protocol, zdrClass: gate.posture.zdrClass, zdrFlags, secretsRedacted, blocked: false });
    const effectiveTimeoutMs = Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0 ? Math.max(this.timeoutMs, turnTimeoutMs) : this.timeoutMs;
    const timeout=AbortSignal.timeout(effectiveTimeoutMs);
    let response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'});
    // Defensive HTTP 400 fallback: if an endpoint rejects injected reasoning_effort / reasoning / stream_options / assistant prefill, retry once cleanly.
    if (response.status === 400 && (body.reasoning_effort || body.reasoning || body.stream_options || prefillMeta?.rawPrefill)) {
      await response.body?.cancel?.().catch(() => {});
      const retryBody = { ...body };
      delete retryBody.reasoning_effort;
      delete retryBody.reasoning;
      delete retryBody.stream_options;
      if (prefillMeta?.rawPrefill) {
        if (Array.isArray(retryBody.messages) && retryBody.messages.at(-1)?.role === 'assistant') retryBody.messages = retryBody.messages.slice(0, -1);
        if (Array.isArray(retryBody.input) && retryBody.input.at(-1)?.role === 'assistant') retryBody.input = retryBody.input.slice(0, -1);
        prefillMeta = null;
      }
      response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(retryBody), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
    }
    const MAX_THINKING_CHARS=24000;
    const appendThinking=(cur,chunk)=>cur.length>=MAX_THINKING_CHARS?cur:(cur+chunk).slice(0,MAX_THINKING_CHARS);
    const formatThinking=value=>typeof value==='string'&&value.trim()?{thinking:value.slice(0,MAX_THINKING_CHARS)}:{};
    if(body.stream&&response.ok&&!(response.headers?.get('content-type')||'').includes('application/json')) {
      let text='',thinking='',refusal=false,incomplete=false,outputLimited=false,usage=null,modelId=this.model,lineBuf='',bytes=0,currentEvent='',streamError=null;
      let calls=[];
      const decoder=new TextDecoder();
      if(this.protocol==='anthropic') {
        let stopReason=null,messageStopped=false;
        const blocks=new Map();
        const handleData=(eventType,payload)=>{
          if(payload==='[DONE]')return;
          let parsed;try{parsed=JSON.parse(payload);}catch{return;}
          const type=parsed.type||eventType;
          if(type==='message_start') {
            if(parsed.message?.model)modelId=parsed.message.model;
            if(parsed.message?.usage)usage={...parsed.message.usage};
            if(parsed.message?.stop_reason)stopReason=parsed.message.stop_reason;
          } else if(type==='content_block_start') {
            const idx=parsed.index??blocks.size,cb=parsed.content_block||{};
            if(cb.type==='tool_use') {
              const hasObj=cb.input&&typeof cb.input==='object'&&!Array.isArray(cb.input)&&Object.keys(cb.input).length>0;
              blocks.set(idx,{type:'tool_use',id:cb.id||'',name:cb.name||'',inputJson:'',inputObj:hasObj?cb.input:null});
            } else if(cb.type==='text') {
              blocks.set(idx,{type:'text'});
              if(typeof cb.text==='string'&&cb.text){text+=cb.text;try{onDelta({type:'text',text:cb.text});}catch{}}
            } else if(cb.type==='thinking') {
              blocks.set(idx,{type:'thinking'});
              if(typeof cb.thinking==='string'&&cb.thinking){thinking=appendThinking(thinking,cb.thinking);try{onDelta({type:'thinking',text:cb.thinking});}catch{}}
            }
          } else if(type==='content_block_delta') {
            const idx=parsed.index,d=parsed.delta||{};
            if(d.type==='text_delta'&&typeof d.text==='string'&&d.text){text+=d.text;try{onDelta({type:'text',text:d.text});}catch{}}
            else if(d.type==='thinking_delta'&&typeof d.thinking==='string'&&d.thinking){thinking=appendThinking(thinking,d.thinking);try{onDelta({type:'thinking',text:d.thinking});}catch{}}
            else if(d.type==='input_json_delta'&&typeof d.partial_json==='string') {
              if(!blocks.has(idx))blocks.set(idx,{type:'tool_use',id:'',name:'',inputJson:'',inputObj:null});
              blocks.get(idx).inputJson+=d.partial_json;
            }
          } else if(type==='message_stop') {
            messageStopped=true;
          } else if(type==='message_delta') {
            if(parsed.delta?.stop_reason)stopReason=parsed.delta.stop_reason;
            if(parsed.usage)usage={...(usage||{}),...parsed.usage};
          } else if(type==='error') {
            streamError=parsed.error||parsed;
          }
        };
        const processLine=(rawLine)=>{
          const line=rawLine.endsWith('\r')?rawLine.slice(0,-1):rawLine;
          if(!line){currentEvent='';return;}
          if(line.startsWith('event:')){currentEvent=line.slice(6).trim();return;}
          if(line.startsWith('data:')){handleData(currentEvent,line.slice(5).trim());}
        };
        for await(const chunk of response.body) {
          bytes+=chunk.byteLength;
          if(bytes>32*1024*1024){await response.body?.cancel?.().catch(()=>{});throw Object.assign(new Error('Provider streaming response exceeded 32 MiB'),{code:'tool_protocol'});}
          lineBuf+=decoder.decode(chunk,{stream:true});
          const lines=lineBuf.split('\n');lineBuf=lines.pop();
          for(const line of lines)processLine(line);
        }
        lineBuf+=decoder.decode();
        if(lineBuf.trim())for(const line of lineBuf.split('\n'))processLine(line);
        if(streamError) {
          const errType=String(streamError.type||'provider_error');
          const retryable=['overloaded_error','rate_limit_error','api_error'].includes(errType);
          return {type:'error',code:errType==='rate_limit_error'?'rate_limit':errType,message:String(streamError.message||'Anthropic stream error').slice(0,1000),retryable,usage:usage||null,model:modelId};
        }
        if(!messageStopped||!stopReason) {
          return {type:'error',code:'provider_incomplete',message:'Anthropic stream ended before message_stop and a stop reason; no tool calls were executed.',retryable:true,usage:usage||null,model:modelId,...formatThinking(thinking)};
        }
        calls=[...blocks.entries()].sort((a,b)=>a[0]-b[0]).filter(([,b])=>b.type==='tool_use').map(([,b])=>({id:b.id,name:b.name,arguments:b.inputJson.trim()?b.inputJson:(b.inputObj||{})}));
        refusal=stopReason==='refusal';
        incomplete=outputLimited=stopReason==='max_tokens';
      } else if(this.protocol==='openai-responses') {
        let respStatus=null,incompleteDetails=null;
        const fnOrder=[],fnById=new Map(),fnByIndex=new Map();
        const getFnCall=(itemId,outputIndex)=>{
          if(itemId&&fnById.has(itemId))return fnById.get(itemId);
          if(outputIndex!==undefined&&fnByIndex.has(outputIndex))return fnByIndex.get(outputIndex);
          const entry={id:itemId||'',name:'',arguments:''};
          fnOrder.push(entry);
          if(itemId)fnById.set(itemId,entry);
          if(outputIndex!==undefined)fnByIndex.set(outputIndex,entry);
          return entry;
        };
        const handleData=(eventType,payload)=>{
          if(payload==='[DONE]')return;
          let parsed;try{parsed=JSON.parse(payload);}catch{return;}
          const type=parsed.type||eventType;
          if(type==='response.created'||type==='response.in_progress') {
            if(parsed.response?.model)modelId=parsed.response.model;
          } else if(type==='response.output_text.delta') {
            if(typeof parsed.delta==='string'&&parsed.delta){text+=parsed.delta;try{onDelta({type:'text',text:parsed.delta});}catch{}}
          } else if(type==='response.refusal.delta') {
            if(typeof parsed.delta==='string'){refusal=true;text+=parsed.delta;}
          } else if(type==='response.reasoning_summary_text.delta'||type==='response.reasoning_text.delta') {
            if(typeof parsed.delta==='string'&&parsed.delta){thinking=appendThinking(thinking,parsed.delta);try{onDelta({type:'thinking',text:parsed.delta});}catch{}}
          } else if(type==='response.output_item.added') {
            const item=parsed.item||{};
            if(item.type==='function_call') {
              const entry=getFnCall(item.id,parsed.output_index);
              if(item.call_id)entry.id=item.call_id; else if(item.id&&!entry.id)entry.id=item.id;
              if(item.name)entry.name=item.name;
              if(typeof item.arguments==='string'&&item.arguments)entry.arguments=item.arguments;
            }
          } else if(type==='response.function_call_arguments.delta') {
            const entry=getFnCall(parsed.item_id,parsed.output_index);
            if(typeof parsed.delta==='string')entry.arguments+=parsed.delta;
          } else if(type==='response.function_call_arguments.done') {
            const entry=getFnCall(parsed.item_id,parsed.output_index);
            if(typeof parsed.arguments==='string')entry.arguments=parsed.arguments;
            if(parsed.name)entry.name=parsed.name;
          } else if(type==='response.output_item.done') {
            const item=parsed.item||{};
            if(item.type==='function_call') {
              const entry=getFnCall(item.id,parsed.output_index);
              if(item.call_id)entry.id=item.call_id; else if(item.id&&!entry.id)entry.id=item.id;
              if(item.name)entry.name=item.name;
              if(typeof item.arguments==='string')entry.arguments=item.arguments;
            } else if(item.type==='message'&&!text) {
              for(const c of item.content||[]) {
                if(c.type==='output_text'&&typeof c.text==='string')text+=c.text;
                if(c.type==='refusal'&&typeof c.refusal==='string'){refusal=true;text+=c.refusal;}
              }
            } else if(item.type==='reasoning'&&!thinking) {
              for(const s of [...(item.summary||[]),...(item.content||[])]) {
                if(typeof s?.text==='string'&&s.text)thinking=appendThinking(thinking,s.text);
              }
            }
          } else if(['response.completed','response.incomplete','response.failed','response.cancelled'].includes(type)) {
            const resp=parsed.response||parsed;
            if(resp.model)modelId=resp.model;
            if(resp.usage)usage=resp.usage;
            respStatus=resp.status||type.slice('response.'.length);
            if(resp.incomplete_details)incompleteDetails=resp.incomplete_details;
            if(Array.isArray(resp.output)) {
              if(!fnOrder.length) {
                for(const b of resp.output)if(b.type==='function_call')fnOrder.push({id:b.call_id||b.id,name:b.name,arguments:b.arguments});
              }
              if(!text) {
                for(const b of resp.output)if(b.type==='message')for(const c of b.content||[]) {
                  if(c.type==='output_text'&&typeof c.text==='string')text+=c.text;
                  if(c.type==='refusal'&&typeof c.refusal==='string'){refusal=true;text+=c.refusal;}
                }
              }
              if(!thinking) {
                for(const b of resp.output)if(b.type==='reasoning')for(const s of [...(b.summary||[]),...(b.content||[])]) {
                  if(typeof s?.text==='string'&&s.text)thinking=appendThinking(thinking,s.text);
                }
              }
            }
          } else if(type==='error') {
            streamError=parsed.error||parsed;
          }
        };
        const processLine=(rawLine)=>{
          const line=rawLine.endsWith('\r')?rawLine.slice(0,-1):rawLine;
          if(!line){currentEvent='';return;}
          if(line.startsWith('event:')){currentEvent=line.slice(6).trim();return;}
          if(line.startsWith('data:')){handleData(currentEvent,line.slice(5).trim());}
        };
        for await(const chunk of response.body) {
          bytes+=chunk.byteLength;
          if(bytes>32*1024*1024){await response.body?.cancel?.().catch(()=>{});throw Object.assign(new Error('Provider streaming response exceeded 32 MiB'),{code:'tool_protocol'});}
          lineBuf+=decoder.decode(chunk,{stream:true});
          const lines=lineBuf.split('\n');lineBuf=lines.pop();
          for(const line of lines)processLine(line);
        }
        lineBuf+=decoder.decode();
        if(lineBuf.trim())for(const line of lineBuf.split('\n'))processLine(line);
        if(streamError) {
          return {type:'error',code:String(streamError.code||'provider_response_failed'),message:String(streamError.message||'Provider stream error').slice(0,1000),retryable:true,usage:usage||null,model:modelId};
        }
        if(respStatus==='failed'||respStatus==='cancelled') {
          return {type:'error',code:'provider_response_failed',message:'Provider did not complete the response.',retryable:true,usage:usage||null,model:modelId};
        }
        if(!['completed','incomplete'].includes(respStatus)) {
          return {type:'error',code:'provider_incomplete',message:'Responses stream ended before a terminal event; no tool calls were executed.',retryable:true,usage:usage||null,model:modelId,...formatThinking(thinking)};
        }
        calls=fnOrder.map(tc=>({id:tc.id,name:tc.name,arguments:tc.arguments}));
        refusal ||= incompleteDetails?.reason==='content_filter';
        incomplete=respStatus==='incomplete';
        outputLimited=incomplete&&incompleteDetails?.reason==='max_output_tokens';
      } else {
        let finishReason=null,lastTcIdx=0;
        const toolCallAccum=new Map();
        const processLine=(rawLine)=>{
          const line=rawLine.endsWith('\r')?rawLine.slice(0,-1):rawLine;
          if(!line.startsWith('data:'))return;
          const payload=line.slice(5).trim();
          if(!payload||payload==='[DONE]')return;
          let parsed;try{parsed=JSON.parse(payload);}catch{return;}
          if(parsed.error){streamError=parsed.error;return;}
          if(parsed.usage)usage=parsed.usage;
          if(parsed.model)modelId=parsed.model;
          const choice=parsed.choices?.[0];
          if(choice?.finish_reason)finishReason=choice.finish_reason;
          const delta=choice?.delta;if(!delta)return;
          const reasonDelta=typeof delta.reasoning_content==='string'?delta.reasoning_content:typeof delta.reasoning==='string'?delta.reasoning:'';
          if(reasonDelta){thinking=appendThinking(thinking,reasonDelta);try{onDelta({type:'thinking',text:reasonDelta});}catch{}}
          if(delta.content){text+=delta.content;try{onDelta({type:'text',text:delta.content});}catch{}}
          if(delta.refusal){refusal=true;text+=delta.refusal;}
          if(delta.tool_calls)for(const tc of delta.tool_calls){
            let tcIdx;
            if(tc.id){
              const existing=[...toolCallAccum.entries()].find(([,v])=>v.id===tc.id);
              if(existing)tcIdx=existing[0];
              else if(Number.isInteger(tc.index)&&(!toolCallAccum.has(tc.index)||!toolCallAccum.get(tc.index).id))tcIdx=tc.index;
              else tcIdx=Math.max(-1,...toolCallAccum.keys())+1;
            } else if(Number.isInteger(tc.index)) {
              tcIdx=tc.index;
            } else {
              tcIdx=lastTcIdx;
            }
            lastTcIdx=tcIdx;
            if(!toolCallAccum.has(tcIdx))toolCallAccum.set(tcIdx,{id:'',name:'',arguments:''});
            const a=toolCallAccum.get(tcIdx);
            if(tc.id&&!a.id)a.id=tc.id;
            if (tc.extra_content?.google?.thought_signature) {
              a.extra_content = { google: { thought_signature: String(tc.extra_content.google.thought_signature).slice(0, 8192) } };
            }
            if (typeof tc.thought_signature === 'string' && tc.thought_signature) {
              a.thought_signature = tc.thought_signature.slice(0, 8192);
            }
            if(tc.function?.name)a.name+=tc.function.name;
            if(tc.function?.arguments!=null)a.arguments+=typeof tc.function.arguments==='string'?tc.function.arguments:JSON.stringify(tc.function.arguments);
          }
        };
        for await(const chunk of response.body) {
          bytes+=chunk.byteLength;
          if(bytes>32*1024*1024){await response.body?.cancel?.().catch(()=>{});throw Object.assign(new Error('Provider streaming response exceeded 32 MiB'),{code:'tool_protocol'});}
          lineBuf+=decoder.decode(chunk,{stream:true});
          const lines=lineBuf.split('\n');lineBuf=lines.pop();
          for(const line of lines)processLine(line);
        }
        lineBuf+=decoder.decode();
        if(lineBuf.trim())for(const line of lineBuf.split('\n'))processLine(line);
        if(streamError) {
          let errMsg=String(streamError.message||streamError.code||'Provider stream error');
          if(key)errMsg=errMsg.split(key).join('[redacted credential]');
          return {type:'error',code:String(streamError.code||'provider_response_failed'),message:errMsg.slice(0,1000),retryable:true,usage:usage||null,model:modelId};
        }
        if(!finishReason&&!refusal) {
          return {type:'error',code:'provider_incomplete',message:'Streaming response ended before a finish reason arrived; no tool calls were executed.',retryable:true,usage:usage||null,model:modelId,...formatThinking(thinking)};
        }
        calls=[...toolCallAccum.entries()].sort((a,b)=>a[0]-b[0]).map(([,tc])=>({
          id:tc.id,name:tc.name,arguments:tc.arguments,
          ...(tc.extra_content?{extra_content:tc.extra_content}:{}),
          ...(tc.thought_signature?{thought_signature:tc.thought_signature}:{}),
        }));
        refusal||=finishReason==='content_filter';
        incomplete=outputLimited=finishReason==='length';
      }
      const meta={usage:usage||null,model:modelId,...formatThinking(thinking)};
      if(refusal)return {type:'message',text:text||'The provider declined to continue.',finish:'refusal',...meta};
      // Preserve long-form visible text on output truncation so Runtime can seamlessly auto-continue instead of discarding work.
      if(incomplete&&outputLimited&&!calls.length&&text.trim()) {
        const partialStreamText = prefillMeta ? stitchPrefillIntoText(text, prefillMeta) : text;
        return {type:'message',text:partialStreamText,finish:'length',...meta};
      }
      if(incomplete)return {type:'error',code:outputLimited?'output_limit':'provider_incomplete',message:outputLimited&&thinking&&!calls.length?'Provider spent its output token limit on internal reasoning before returning visible text.':'Provider output was incomplete; no tool calls from this response were executed.',retryable:true,...(outputLimited&&thinking&&!calls.length?{exhaustedReasoning:true}:{}),...meta};
      if(!calls.length&&!text.trim())throw Object.assign(new Error('Provider returned no text or complete tool calls'),{code:'tool_protocol'});
      if (!calls.length && tools.length && this.tier === 'local') {
        const extractedCalls = extractTextToolCalls(text, aliases, tools);
        if (extractedCalls.length) return { type: 'tool', calls: extractedCalls, ...meta };
      }
      const finalStreamText = !calls.length && prefillMeta ? stitchPrefillIntoText(text, prefillMeta) : text;
      return calls.length?{type:'tool',calls:normalizeCalls(calls,aliases,tools),...(text?{text}:{}),...meta}:{type:'message',text:finalStreamText,finish:'done',...meta};
    }
    const chunks=[];let bytes=0;
    for await(const chunk of response.body) {
      bytes+=chunk.byteLength;
      if(bytes>8*1024*1024){await response.body?.cancel?.().catch(()=>{});throw Object.assign(new Error('Provider response exceeded 8 MiB'),{code:'tool_protocol'});}
      chunks.push(chunk);
    }
    const raw=Buffer.concat(chunks).toString('utf8');
    let data;try{data=JSON.parse(raw);}catch{if(response.ok)throw Object.assign(new Error(`Provider returned invalid JSON (${response.status})`),{code:'tool_protocol'});data={};}
    if(!response.ok) {
      let message=String(data.error?.message||`Provider HTTP ${response.status}`);
      if(key)message=message.split(key).join('[redacted credential]');
      const retryable=response.status===429||response.status>=500;
      const retryAfterMs=retryable?retryAfterMilliseconds(response.headers?.get('retry-after')):undefined;
      return {type:'error',code:response.status===401||response.status===403?'authentication':response.status===429?'rate_limit':`http_${response.status}`,message:message.slice(0,1000),retryable,...(retryAfterMs===undefined?{}:{retryAfterMs})};
    }
    if(!data||typeof data!=='object'||Array.isArray(data))throw Object.assign(new Error('Provider returned a malformed response object'),{code:'tool_protocol'});
    let calls=[],text='',thinking='',refusal=false,incomplete=false,outputLimited=false;
    if(this.protocol==='anthropic') {
      if(!Array.isArray(data.content))throw Object.assign(new Error('Anthropic response omitted content blocks'),{code:'tool_protocol'});
      for(const b of data.content||[]) {if(b.type==='tool_use')calls.push({id:b.id,name:b.name,arguments:b.input});else if(b.type==='text')text+=b.text;else if(b.type==='thinking'&&typeof b.thinking==='string')thinking=appendThinking(thinking,b.thinking);}
      refusal=data.stop_reason==='refusal';
      incomplete=outputLimited=data.stop_reason==='max_tokens';
    } else if(this.protocol==='openai-responses') {
      if(!Array.isArray(data.output))throw Object.assign(new Error('Responses response omitted output blocks'),{code:'tool_protocol'});
      for(const b of data.output||[]) {
        if(b.type==='function_call')calls.push({id:b.call_id||b.id,name:b.name,arguments:b.arguments});
        if(b.type==='message')for(const c of b.content||[]) {if(c.type==='output_text')text+=c.text;if(c.type==='refusal'){refusal=true;text+=c.refusal;}}
        if(b.type==='reasoning')for(const s of [...(b.summary||[]),...(b.content||[])]) {if(typeof s?.text==='string'&&s.text)thinking=appendThinking(thinking,s.text);}
      }
      refusal ||= data.incomplete_details?.reason==='content_filter';
      incomplete=data.status==='incomplete';
      outputLimited=incomplete&&data.incomplete_details?.reason==='max_output_tokens';
      if(data.status==='failed'||data.status==='cancelled')return {type:'error',code:'provider_response_failed',message:'Provider did not complete the response.',retryable:true};
    } else {
      const choice=data.choices?.[0],m=choice?.message;
      if(!m||typeof m!=='object')throw Object.assign(new Error('Chat response omitted an assistant message'),{code:'tool_protocol'});
      text=typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter(part=>part.type==='text').map(part=>part.text||'').join(''):'';
      const rawThinking=typeof m.reasoning_content==='string'?m.reasoning_content:typeof m.reasoning==='string'?m.reasoning:'';
      if(rawThinking)thinking=appendThinking(thinking,rawThinking);
      refusal=Boolean(m.refusal)||choice.finish_reason==='content_filter';if(m.refusal)text+=m.refusal;
      incomplete=outputLimited=choice.finish_reason==='length';
      calls=(m.tool_calls||[]).map(c=>({
        id:c.id,
        ...c.function,
        ...(c.extra_content?{extra_content:c.extra_content}:{}),
        ...(c.thought_signature?{thought_signature:c.thought_signature}:{}),
      }));
    }
    const meta={usage:data.usage||null,model:data.model||this.model,...formatThinking(thinking)};
    // A refusal or truncated tool batch must never accidentally execute partial tool calls.
    if(refusal)return {type:'message',text:text||'The provider declined to continue.',finish:'refusal',...meta};
    if(incomplete&&outputLimited&&!calls.length&&text.trim()) {
      const partialJsonText = prefillMeta ? stitchPrefillIntoText(text, prefillMeta) : text;
      return {type:'message',text:partialJsonText,finish:'length',...meta};
    }
    if(incomplete)return {type:'error',code:outputLimited?'output_limit':'provider_incomplete',message:outputLimited&&thinking&&!calls.length?'Provider spent its output token limit on internal reasoning before returning visible text.':'Provider output was incomplete; no tool calls from this response were executed.',retryable:true,...(outputLimited&&thinking&&!calls.length?{exhaustedReasoning:true}:{}),...meta};
    if(!calls.length&&!text.trim())throw Object.assign(new Error('Provider returned no text or complete tool calls'),{code:'tool_protocol'});
    if (!calls.length && tools.length && this.tier === 'local') {
      const extractedCalls = extractTextToolCalls(text, aliases, tools);
      if (extractedCalls.length) return { type: 'tool', calls: extractedCalls, ...meta };
    }
    const finalJsonText = !calls.length && prefillMeta ? stitchPrefillIntoText(text, prefillMeta) : text;
    return calls.length?{type:'tool',calls:normalizeCalls(calls,aliases,tools),...(text?{text}:{}),...meta}:{type:'message',text:finalJsonText,finish:'done',...meta};
  }
  async continueTurn(context, partialText, signal, { requestProfile, onDelta, turnTimeoutMs, privacy = DEFAULT_PRIVACY_SETTINGS, onOutbound, extraSecrets } = {}) {
    if (this.closed) return { type: 'error', code: 'provider_configuration', message: 'Provider is closed.', retryable: false };
    if (signal?.aborted) throw signal.reason || Object.assign(new Error('Provider request cancelled'), { code: 'cancelled' });
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: extractHost(this.baseUrl), protocol: this.protocol, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    if (!this.available) return { type: 'error', code: 'authentication', message: `Set ${this.apiKeyEnv} in the server environment.`, retryable: false };
    const profile = outputProfile(requestProfile, this.maxOutputTokens, this.maxOutputTokensCeiling);
    const generation = parametersFor(this, context.task?.generation);
    const boosted = Math.min(this.maxOutputTokensCeiling || 64000, Math.max(profile.maxOutputTokens * 2, 32768));
    const maxOutputTokens = Math.min(boosted, parameterLimits(this).fields.max_tokens.max);
    const tools = context.tools ?? canonicalTools;
    let prompt = compileTaskContext({ ...context, tools });
    let instructions = compileInstructions(context);
    let partial = String(partialText || '');
    let secretsRedacted = 0;
    if (!gate.posture.skipSecretRedaction && privacy?.redactOutboundSecrets !== false) {
      const cleaned = redactOutboundValue([prompt, instructions, partial], extraSecrets || environmentSecrets());
      [prompt, instructions, partial] = cleaned.value;
      secretsRedacted = cleaned.count;
    }
    const headers = { 'content-type': 'application/json', ...this.headers };
    const key = httpCredentials.get(this) ?? (this.apiKeyEnv ? process.env[this.apiKeyEnv] : null);
    let endpoint, body;
    if (this.protocol === 'anthropic') {
      endpoint = this.baseUrl.replace(/\/$/, '') + '/messages';
      if (key) headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: this.model, max_tokens: maxOutputTokens,
        system: [{ type: 'text', text: instructions, cache_control: { type: 'ephemeral' } }],
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: partial },
          { role: 'user', content: AUTO_CONTINUE_PROMPT },
        ],
      };
    } else if (this.protocol === 'openai-responses') {
      endpoint = this.baseUrl.replace(/\/$/, '') + '/responses';
      if (key) headers.authorization = `Bearer ${key}`;
      body = {
        model: this.model, instructions, max_output_tokens: maxOutputTokens, store: false,
        input: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: partial },
          { role: 'user', content: AUTO_CONTINUE_PROMPT },
        ],
      };
    } else {
      endpoint = this.baseUrl.replace(/\/$/, '') + '/chat/completions';
      if (key) headers.authorization = `Bearer ${key}`;
      body = {
        model: this.model, max_tokens: maxOutputTokens,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: prompt },
          { role: 'assistant', content: partial },
          { role: 'user', content: AUTO_CONTINUE_PROMPT },
        ],
      };
    }
    Object.assign(body, generation);
    if (this.protocol === 'openai-responses' && Object.hasOwn(generation, 'max_tokens')) {
      body.max_output_tokens = generation.max_tokens;
      delete body.max_tokens;
    }
    const { zdrFlags } = applyZdrRequestPolicy(this, body, privacy);
    if (onDelta) {
      body.stream = true;
      if (this.protocol === 'openai-chat') body.stream_options = { include_usage: true };
    }
    onOutbound?.({ providerId: this.id, host: extractHost(this.baseUrl), protocol: this.protocol, zdrClass: gate.posture.zdrClass, zdrFlags, secretsRedacted, blocked: false });
    const effectiveTimeoutMs = Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0 ? Math.max(this.timeoutMs, turnTimeoutMs) : this.timeoutMs;
    const timeout = AbortSignal.timeout(effectiveTimeoutMs);
    let response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
    if (response.status === 400 && body.stream_options) {
      await response.body?.cancel?.().catch(() => {});
      const retryBody = { ...body };
      delete retryBody.stream_options;
      response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(retryBody), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfterMs = retryable ? retryAfterMilliseconds(response.headers?.get('retry-after')) : undefined;
      return { type: 'error', code: response.status === 429 ? 'rate_limit' : `http_${response.status}`, message: `Continuation HTTP ${response.status}`, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
    }
    if (body.stream && response.body && !(response.headers?.get('content-type') || '').includes('application/json')) {
      let text = '', refusal = false, outputLimited = false, sawTerminal = false, lineBuf = '', bytes = 0, currentEvent = '', streamError = null;
      const decoder = new TextDecoder();
      const handleLine = rawLine => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line) { currentEvent = ''; return; }
        if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); return; }
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let parsed; try { parsed = JSON.parse(payload); } catch { return; }
        if (parsed.error || (parsed.type || currentEvent) === 'error') {
          streamError = parsed.error || parsed;
          return;
        }
        if (this.protocol === 'anthropic') {
          const type = parsed.type || currentEvent;
          if (type === 'content_block_start' && parsed.content_block?.type === 'text' && typeof parsed.content_block.text === 'string' && parsed.content_block.text) {
            text += parsed.content_block.text; try { onDelta({ type: 'text', text: parsed.content_block.text }); } catch {}
          } else if (type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string') {
            text += parsed.delta.text; try { onDelta({ type: 'text', text: parsed.delta.text }); } catch {}
          } else if (type === 'message_delta' && parsed.delta?.stop_reason) {
            sawTerminal = true;
            if (parsed.delta.stop_reason === 'max_tokens') outputLimited = true;
            if (parsed.delta.stop_reason === 'refusal') refusal = true;
          } else if (type === 'message_stop') {
            sawTerminal = true;
          }
        } else if (this.protocol === 'openai-responses') {
          const type = parsed.type || currentEvent;
          if (type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
            text += parsed.delta; try { onDelta({ type: 'text', text: parsed.delta }); } catch {}
          } else if (type === 'response.refusal.delta' && typeof parsed.delta === 'string') {
            refusal = true; text += parsed.delta;
          } else if (type === 'response.output_item.done' && parsed.item?.type === 'message' && !text) {
            for (const c of parsed.item.content || []) {
              if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
              if (c.type === 'refusal' && typeof c.refusal === 'string') { refusal = true; text += c.refusal; }
            }
          } else if (type === 'response.completed') {
            sawTerminal = true;
            const resp = parsed.response || parsed;
            if (!text && Array.isArray(resp.output)) {
              for (const b of resp.output) if (b.type === 'message') for (const c of b.content || []) {
                if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
                if (c.type === 'refusal' && typeof c.refusal === 'string') { refusal = true; text += c.refusal; }
              }
            }
          } else if (type === 'response.incomplete') {
            sawTerminal = true;
            const resp = parsed.response || parsed;
            if (resp.incomplete_details?.reason === 'max_output_tokens') outputLimited = true;
            if (resp.incomplete_details?.reason === 'content_filter') refusal = true;
          } else if (type === 'response.failed' || type === 'response.cancelled') {
            streamError = parsed.response?.error || { message: `Continuation ${type}` };
          }
        } else {
          const ch = parsed.choices?.[0];
          if (ch?.finish_reason) sawTerminal = true;
          if (ch?.finish_reason === 'length') outputLimited = true;
          if (ch?.finish_reason === 'content_filter') refusal = true;
          if (typeof ch?.delta?.content === 'string' && ch.delta.content) {
            text += ch.delta.content; try { onDelta({ type: 'text', text: ch.delta.content }); } catch {}
          }
          if (typeof ch?.delta?.refusal === 'string' && ch.delta.refusal) { refusal = true; text += ch.delta.refusal; }
        }
      };
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 32 * 1024 * 1024) {
          await response.body?.cancel?.().catch(() => {});
          return { type: 'error', code: 'tool_protocol', message: 'Continuation stream exceeded 32 MiB', retryable: true };
        }
        lineBuf += decoder.decode(chunk, { stream: true });
        const lines = lineBuf.split('\n'); lineBuf = lines.pop();
        for (const line of lines) handleLine(line);
      }
      lineBuf += decoder.decode();
      if (lineBuf.trim()) for (const line of lineBuf.split('\n')) handleLine(line);
      if (streamError) {
        let errMsg = String(streamError.message || streamError.code || 'Continuation stream error');
        if (key) errMsg = errMsg.split(key).join('[redacted credential]');
        return { type: 'error', code: 'provider_response_failed', message: errMsg.slice(0, 1000), retryable: true };
      }
      if (!sawTerminal && !refusal) {
        return { type: 'error', code: 'provider_incomplete', message: 'Continuation stream ended before completion.', retryable: true };
      }
      if (!refusal && !text.trim()) {
        return { type: 'error', code: 'provider_incomplete', message: 'Continuation stream ended with no text.', retryable: true };
      }
      return { type: 'message', text, finish: refusal ? 'refusal' : outputLimited ? 'length' : 'done' };
    }
    const jsonChunks = []; let jsonBytes = 0;
    for await (const chunk of response.body) {
      jsonBytes += chunk.byteLength;
      if (jsonBytes > 8 * 1024 * 1024) {
        await response.body?.cancel?.().catch(() => {});
        return { type: 'error', code: 'tool_protocol', message: 'Continuation response exceeded 8 MiB', retryable: true };
      }
      jsonChunks.push(chunk);
    }
    let data; try { data = JSON.parse(Buffer.concat(jsonChunks).toString('utf8')); } catch { return { type: 'error', code: 'tool_protocol', message: 'Invalid continuation JSON', retryable: true }; }
    let text = '', refusal = false, outputLimited = false;
    if (this.protocol === 'anthropic') {
      for (const b of data.content || []) if (b.type === 'text') text += b.text;
      refusal = data.stop_reason === 'refusal';
      outputLimited = data.stop_reason === 'max_tokens';
    } else if (this.protocol === 'openai-responses') {
      for (const b of data.output || []) if (b.type === 'message') for (const c of b.content || []) {
        if (c.type === 'output_text') text += c.text;
        if (c.type === 'refusal') { refusal = true; text += c.refusal; }
      }
      outputLimited = data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens';
      refusal ||= data.incomplete_details?.reason === 'content_filter';
    } else {
      const ch = data.choices?.[0], m = ch?.message;
      text = typeof m?.content === 'string' ? m.content
        : Array.isArray(m?.content) ? m.content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('')
        : '';
      refusal = Boolean(m?.refusal) || ch?.finish_reason === 'content_filter';
      outputLimited = ch?.finish_reason === 'length';
    }
    if (!refusal && !text.trim()) {
      return { type: 'error', code: 'provider_incomplete', message: 'Continuation returned empty output.', retryable: true };
    }
    return { type: 'message', text, finish: refusal ? 'refusal' : outputLimited ? 'length' : 'done' };
  }
}

export function normalizeCliSettings(kind, raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const k = String(kind || '').toLowerCase();
  if (k === 'codex' || k === 'codex-cli') {
    const reasoningEffort = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(input.reasoningEffort) ? input.reasoningEffort : null;
    const serviceTier = ['fast', 'priority', 'flex'].includes(input.serviceTier) ? input.serviceTier : null;
    const verbosity = ['low', 'medium', 'high'].includes(input.verbosity) ? input.verbosity : null;
    return { reasoningEffort, serviceTier, verbosity };
  }
  if (k === 'claude' || k === 'claude-code') {
    const effort = ['low', 'medium', 'high', 'max'].includes(input.effort) ? input.effort : null;
    return { effort };
  }
  if (k === 'antigravity' || k === 'antigravity-cli') {
    const reasoningEffort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoningEffort) ? input.reasoningEffort : null;
    return { reasoningEffort };
  }
  return {};
}

export function buildCodexExecArgs({ schemaPath, cwd, model = null, taskEffort = 'medium', cliSettings = {} } = {}) {
  const settings = normalizeCliSettings('codex', cliSettings);
  const taskEff = String(taskEffort || 'medium').toLowerCase();
  const effectiveReasoning = settings.reasoningEffort
    || (taskEff === 'fast' ? 'low' : taskEff === 'high' ? 'high' : taskEff === 'max' ? 'xhigh' : null);
  const args = [
    'exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only',
    '--skip-git-repo-check', '--json', '--color', 'never',
    '--output-schema', schemaPath, '--cd', cwd,
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"'
  ];
  if (effectiveReasoning) args.push('-c', `model_reasoning_effort="${effectiveReasoning}"`);
  if (settings.serviceTier) args.push('-c', `service_tier="${settings.serviceTier}"`);
  if (settings.verbosity) args.push('-c', `model_verbosity="${settings.verbosity}"`);
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'in_app_browser', 'goals', 'memories', 'workspace_dependencies']) {
    args.push('--disable', feature);
  }
  if (model) args.push('--model', model);
  args.push('-');
  return args;
}

export function buildClaudeExecArgs({ schemaJson, systemPrompt, model = null, taskEffort = 'medium', cliSettings = {}, includeEffort = true } = {}) {
  const settings = normalizeCliSettings('claude', cliSettings);
  const taskEff = String(taskEffort || 'medium').toLowerCase();
  const effectiveEffort = settings.effort
    || (taskEff === 'fast' ? 'low' : taskEff === 'high' ? 'high' : taskEff === 'max' ? 'max' : null);
  const args = [
    '--print', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--tools', '', '--disable-slash-commands', '--no-chrome',
    '--permission-mode', 'dontAsk', '--setting-sources', '',
    '--settings', JSON.stringify({ disableAllHooks: true, enabledPlugins: {} }),
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--max-turns', '3', '--json-schema', schemaJson,
    '--system-prompt', systemPrompt
  ];
  if (model) args.push('--model', model);
  if (includeEffort && effectiveEffort) args.push('--effort', effectiveEffort);
  return args;
}

/** Experimental bridge: CLI turns are visible, underlying CLI transport retries are opaque. */
export class CodexProvider {
  constructor({id='codex-cli',label='Codex CLI · live experimental bridge',binary=process.env.G0D_CODEX_BINARY||'codex',timeoutMs=120000,model,environment=process.env,tier='frontier',subscriptionId='codex-cli',cliSettings={}}={}) {
    Object.assign(this,{id,label,binary,timeoutMs,model,subscriptionId,cliSettings:normalizeCliSettings('codex',cliSettings),tier:inferProviderTier({id,model,tier})});cliEnvironments.set(this,cliEnvironment(environment));this.kind='codex';this.available=true;
    this.accounting='CLI turns and reported tokens; underlying provider attempts are opaque';
    this.capabilities=providerCapabilities(false,'bridge');
    this.children=new Set();this.closed=false;this.closePromise=null;
  }
  async turn(context,{signal,turnTimeoutMs,privacy=DEFAULT_PRIVACY_SETTINGS,onOutbound,extraSecrets}={}) {
    if(this.closed)throw Object.assign(new Error('Codex provider is closed'),{code:'PROVIDER_CLOSED',retryable:false});
    const environment=cliEnvironments.get(this);
    if(!environment)throw Object.assign(new Error('Codex provider is closed'),{code:'PROVIDER_CLOSED',retryable:false});
    if(signal?.aborted)throw signal.reason||Object.assign(new Error('Codex request cancelled'),{code:'cancelled'});
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: 'cli:codex', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const cleaned = privacy.redactOutboundSecrets === false ? { value: context, count: 0 } : redactOutboundValue(context, extraSecrets || environmentSecrets());
    context = cleaned.value;
    onOutbound?.({ providerId: this.id, host: 'cli:codex', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: ['cli:telemetry-disabled'], secretsRedacted: cleaned.count, blocked: false });
    const tools=context.tools??canonicalTools;
    // Generate from the advertised registry each turn: a new broker tool cannot silently
    // disappear behind a stale CLI schema, and a restricted turn cannot gain extra tools.
    const schemaDir=await fs.mkdtemp(path.join(tmpdir(),'g0d-decision-'));
    try {
    const schema=path.join(schemaDir,'decision.schema.json');
    await fs.writeFile(schema,JSON.stringify(decisionSchema(tools)),{mode:0o600});
    const args = buildCodexExecArgs({
      schemaPath: schema,
      cwd: context.task?.workspace || schemaDir,
      model: this.model || null,
      taskEffort: context.task?.effort || 'medium',
      cliSettings: this.cliSettings
    });
    const prompt=compilePrompt({...context,tools})+`\n\nThis is a planner-only bridge. DO NOT invoke any Codex tools. Return only the JSON schema next-action envelope.\n`+
      `For tool actions set type="tool", calls=[{id:"a stable unique identifier",name:"repo.write",arguments:"a JSON string of arguments"}], text="", finish="continue".\n`+
      `Available tools: ${JSON.stringify(tools)}\n`+
      `For a final response set type="message",calls=[],text="summary",finish="done". Native tool actions are unavailable; the outer local tool broker executes the described calls.`;
    const result=await new Promise((resolve,reject)=>{
      // Temp/schema preparation yields. Close or cancellation during that work
      // must never spawn a late child or fall back to process.env inheritance.
      if(this.closed||cliEnvironments.get(this)!==environment){reject(Object.assign(new Error('Codex provider is closed'),{code:'PROVIDER_CLOSED',retryable:false}));return;}
      if(signal?.aborted){reject(Object.assign(new Error('Codex bridge cancelled'),{code:'cancelled'}));return;}
      const child=spawn(this.binary,args,{stdio:['pipe','pipe','pipe'],env:environment,detached:process.platform!=='win32'});
      const outChunks=[],errChunks=[];
      let outBytes=0,errBytes=0,settled=false,killTimer,terminating=false,closed=false,resolveExit;
      const exited=new Promise(resolve=>{resolveExit=resolve;});
      const kill=()=>{
        // A reaped leader may still have descendants holding its inherited pipes.
        // Keep terminating the owned process group until the close event, not just exit.
        if(terminating||closed||!Number.isInteger(child.pid))return;terminating=true;
        try{if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{}
        killTimer=setTimeout(()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},500);
      };
      const record={child,exited,terminate:kill};this.children.add(record);
      const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>{kill();done(Object.assign(new Error('Codex bridge cancelled'),{code:'cancelled'}));};
      const cliTimeoutMs = Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0 ? Math.max(this.timeoutMs, turnTimeoutMs) : this.timeoutMs;
      const timer=setTimeout(()=>{kill();done(Object.assign(new Error('Codex bridge timed out'),{code:'ETIMEDOUT'}));},cliTimeoutMs);
      signal?.addEventListener('abort',abort,{once:true});
      child.on('error',e=>done(['ENOENT','EACCES'].includes(e.code)
        ? Object.assign(new Error(`Codex CLI could not start (${e.code}): ${e.message}`,{cause:e}),{code:'provider_configuration',osCode:e.code,retryable:false})
        : e));
      child.stdout.on('data',b=>{outBytes+=b.byteLength;if(outBytes>16*1024*1024){kill();done(Object.assign(new Error('Codex bridge output limit'),{code:'tool_protocol'}));return;}outChunks.push(b);});
      child.stderr.on('data',b=>{if(errBytes<65536){errChunks.push(b);errBytes+=b.byteLength;}});
      child.on('close',code=>{
        closed=true;
        clearTimeout(killTimer);
        this.children.delete(record);resolveExit();
        const out=Buffer.concat(outChunks).toString('utf8');
        const rawErr=Buffer.concat(errChunks).toString('utf8').slice(-8000);
        const err=redactOutboundText(rawErr, extraSecrets || environmentSecrets()).text;
        const failures=out.split('\n').flatMap(line=>{try{const event=JSON.parse(line);return ['error','turn.failed'].includes(event.type)?[event]:[];}catch{return [];}});
        const messages=failures.map(event=>event.message||event.error?.message||'Provider request failed.');
        const diagnostic=redactOutboundText(messages.at(-1)||err.slice(-1200), extraSecrets || environmentSecrets()).text;
        const classification=classifyProviderFailure([...messages,err].join('\n'),failures.flatMap(event=>[event.code,event.error?.code]));
        code===0?done(null,{out,err}):done(Object.assign(new Error(`Codex bridge exited ${code}: ${diagnostic}`),classification));
      });
      if(signal?.aborted){abort();return;}
      child.stdin.on('error',()=>{});child.stdin.end(prompt);
    });
    const events=result.out.split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const forbidden=events.find(e=>['command_execution','mcp_tool_call','web_search','file_change'].includes(e.item?.type));
    if(forbidden)throw Object.assign(new Error('Planner-only bridge attempted an internal tool; response rejected'),{code:'tool_protocol'});
    const messages=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message');
    const last=messages.at(-1)?.item?.text;
    if(!last)throw Object.assign(new Error(`No structured response from Codex bridge: ${result.err.slice(-800)}`),{code:'tool_protocol'});
    let value;try{value=JSON.parse(last);}catch{throw Object.assign(new Error('Codex bridge did not return valid decision JSON'),{code:'tool_protocol'});}
    if(!value||typeof value!=='object'||Array.isArray(value)||!['tool','message'].includes(value.type)||!Array.isArray(value.calls)||typeof value.text!=='string'||!['continue','done','refusal'].includes(value.finish)||Object.keys(value).some(key=>!['type','calls','text','finish'].includes(key)))throw Object.assign(new Error('Codex bridge returned an invalid decision envelope'),{code:'tool_protocol'});
    if((value.type==='tool'&&(!value.calls.length||value.finish!=='continue'))||(value.type==='message'&&value.calls.length))throw Object.assign(new Error('Codex bridge returned inconsistent decision fields'),{code:'tool_protocol'});
    const meta={usage:events.findLast(e=>e.type==='turn.completed')?.usage||null,model:this.model||'codex-configured-default',evidenceKind:'live_codex_cli',accounting:this.accounting};
    if(value.type==='tool')return{type:'tool',calls:normalizeCalls(value.calls,toolAliases(tools),tools),...meta};
    return{type:'message',text:value.text||'',finish:value.finish||'done',...meta};
    } finally { await fs.rm(schemaDir,{recursive:true,force:true}); }
  }
  async draft(messages = [], signal, _maxTokens = 1000, _params = {}, { privacy = DEFAULT_PRIVACY_SETTINGS, onOutbound, extraSecrets } = {}) {
    if (this.closed) return { type: 'error', code: 'PROVIDER_CLOSED', message: 'Codex provider is closed.', retryable: false };
    const environment = cliEnvironments.get(this);
    if (!environment) return { type: 'error', code: 'PROVIDER_CLOSED', message: 'Codex provider is closed.', retryable: false };
    if (signal?.aborted) return { type: 'error', code: 'cancelled', message: 'Codex request cancelled.', retryable: false };
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: 'cli:codex', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const cleaned = privacy.redactOutboundSecrets === false ? { value: messages, count: 0 } : redactOutboundValue(messages, extraSecrets || environmentSecrets());
    onOutbound?.({ providerId: this.id, host: 'cli:codex', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: ['cli:telemetry-disabled'], secretsRedacted: cleaned.count, blocked: false });
    const promptText = [
      'CRITICAL: Planner/advisory text-only call. DO NOT invoke any Codex built-in tools.',
      ...(Array.isArray(cleaned.value) ? cleaned.value.map(m => `${String(m?.role || 'user').toUpperCase()}:\n${String(m?.content || '')}`) : [String(cleaned.value || '')])
    ].join('\n\n');
    const working = await fs.mkdtemp(path.join(tmpdir(), 'g0d-codex-draft-'));
    try {
      const args = [
        'exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only',
        '--skip-git-repo-check', '--json', '--color', 'never', '--cd', working,
        '-c', 'approval_policy="never"', '-c', 'web_search="disabled"'
      ];
      for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'in_app_browser', 'goals', 'memories', 'workspace_dependencies']) {
        args.push('--disable', feature);
      }
      if (this.model) args.push('--model', this.model);
      args.push('-');
      const output = await runSubprocessPlanner(this, { args, cwd: working, signal, timeoutOverrideMs: 60000, input: promptText, env: environment, label: 'Codex' });
      const events = output.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const text = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item?.text || '').join('\n').trim() || output.trim();
      const usage = events.findLast(e => e.type === 'turn.completed')?.usage || null;
      return { type: 'message', text, finish: 'done', usage, model: this.model || 'codex-configured-default' };
    } catch (err) {
      return { type: 'error', code: err?.code || 'provider_error', message: err?.message || 'Codex CLI draft failed.', retryable: Boolean(err?.retryable) };
    } finally {
      await fs.rm(working, { recursive: true, force: true });
    }
  }
  close() {
    if(this.closePromise)return this.closePromise;
    this.closed=true;cliEnvironments.delete(this);
    const records=[...this.children];
    for(const record of records)record.terminate();
    this.closePromise=Promise.all(records.map(record=>record.exited)).then(()=>undefined);
    return this.closePromise;
  }
}

/** Subscription-authenticated Claude Code planner. CLI owns authentication; the broker owns effects. */
export class ClaudeCodeProvider extends CodexProvider {
  constructor({id='claude-code',label='Claude Code · CLI default',binary=process.env.G0D_CLAUDE_BINARY||'claude',timeoutMs=120000,model,environment=process.env,subscriptionId='claude-code',cliSettings={}}={}) {
    super({id,label,binary,timeoutMs,model,environment,subscriptionId});
    this.kind='claude';
    this.cliSettings=normalizeCliSettings('claude',cliSettings);
    this.accounting='CLI turns and reported tokens; underlying provider attempts are opaque';
  }
  async turn(context,{signal,turnTimeoutMs,privacy=DEFAULT_PRIVACY_SETTINGS,onOutbound,extraSecrets}={}) {
    if(this.closed)throw Object.assign(new Error('Claude Code provider is closed'),{code:'PROVIDER_CLOSED',retryable:false});
    if(signal?.aborted)throw Object.assign(new Error('Claude Code bridge cancelled'),{code:'cancelled'});
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: 'cli:claude', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const cleaned = privacy.redactOutboundSecrets === false ? { value: context, count: 0 } : redactOutboundValue(context, extraSecrets || environmentSecrets());
    context = cleaned.value;
    onOutbound?.({ providerId: this.id, host: 'cli:claude', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: ['cli:telemetry-disabled'], secretsRedacted: cleaned.count, blocked: false });
    const tools=context.tools??canonicalTools;
    const working=await fs.mkdtemp(path.join(tmpdir(),'g0d-claude-planner-'));
    try {
      if(this.closed)throw Object.assign(new Error('Claude Code provider is closed'),{code:'PROVIDER_CLOSED',retryable:false});
      // --bare intentionally is not used: it disables subscription OAuth and keychain auth.
      // Empty setting sources, hooks and integrations keep task-side configuration out.
      const schemaJson = JSON.stringify(decisionSchema(tools));
      const systemPrompt = compileInstructions(context)+'\nThis is a planner-only bridge. Do not invoke native tools. Return one next-action decision. The outer local tool broker executes the described calls.';
      const args = buildClaudeExecArgs({
        schemaJson,
        systemPrompt,
        model: this.model || null,
        taskEffort: context.task?.effort || 'medium',
        cliSettings: this.cliSettings,
        includeEffort: true
      });
      const input = compileTaskContext({...context,tools});
      let output;
      try {
        output = await runClaudePlanner(this,{args,cwd:working,signal,turnTimeoutMs,input});
      } catch (err) {
        if (args.includes('--effort') && (err?.code === 'UNSUPPORTED_CLI_FLAG' || /unknown option|unrecognized|invalid option/i.test(String(err?.message || '')))) {
          const fallbackArgs = buildClaudeExecArgs({ schemaJson, systemPrompt, model: this.model || null, taskEffort: context.task?.effort || 'medium', cliSettings: this.cliSettings, includeEffort: false });
          output = await runClaudePlanner(this,{args:fallbackArgs,cwd:working,signal,turnTimeoutMs,input});
        } else {
          throw err;
        }
      }
      const events=output.split('\n').filter(line=>line.trim()).map(line=>{
        try{return JSON.parse(line);}catch{throw Object.assign(new Error('Claude Code returned invalid event JSON'),{code:'tool_protocol'});}
      });
      const internalCall=events.flatMap(event=>event.message?.content||[]).find(block=>
        (block.type==='tool_use'||block.type==='server_tool_use')&&block.name!=='StructuredOutput');
      if(internalCall)throw Object.assign(new Error('Planner-only Claude Code bridge attempted an internal tool; response rejected'),{code:'tool_protocol'});
      const result=events.findLast(event=>event.type==='result');
      if(!result)throw Object.assign(new Error('Claude Code returned no result'),{code:'tool_protocol'});
      if(result.is_error||result.subtype&&result.subtype!=='success') {
        const resHint = String(result.result || result.error || '');
        if (/rate\s*limit|too many requests|429|overloaded|529|capacity|try again later/i.test(resHint)) {
          throw Object.assign(new Error('Claude Code hit a temporary rate limit or capacity spike; retrying.'), { code: 'rate_limit', retryable: true });
        }
        throw Object.assign(new Error('Claude Code could not complete the planner request. Check CLI sign-in, model access and usage limits.'),{code:'provider_configuration',retryable:false});
      }
      const value=result.structured_output;
      if(!value||typeof value!=='object'||Array.isArray(value)||!['tool','message'].includes(value.type)||!Array.isArray(value.calls)||typeof value.text!=='string'||!['continue','done','refusal'].includes(value.finish)||Object.keys(value).some(key=>!['type','calls','text','finish'].includes(key)))throw Object.assign(new Error('Claude Code returned an invalid decision envelope'),{code:'tool_protocol'});
      if((value.type==='tool'&&(!value.calls.length||value.finish!=='continue'))||(value.type==='message'&&value.calls.length))throw Object.assign(new Error('Claude Code returned inconsistent decision fields'),{code:'tool_protocol'});
      const meta={usage:result.usage||null,model:this.model||'claude-cli-default',evidenceKind:'live_claude_cli',accounting:this.accounting};
      return value.type==='tool'?{type:'tool',calls:normalizeCalls(value.calls,toolAliases(tools),tools),...meta}:{type:'message',text:value.text,finish:value.finish,...meta};
    } finally {await fs.rm(working,{recursive:true,force:true});}
  }
  async draft(messages = [], signal, _maxTokens = 1000, _params = {}, { privacy = DEFAULT_PRIVACY_SETTINGS, onOutbound, extraSecrets } = {}) {
    if (this.closed) return { type: 'error', code: 'PROVIDER_CLOSED', message: 'Claude Code provider is closed.', retryable: false };
    if (signal?.aborted) return { type: 'error', code: 'cancelled', message: 'Claude Code request cancelled.', retryable: false };
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: 'cli:claude', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const cleaned = privacy.redactOutboundSecrets === false ? { value: messages, count: 0 } : redactOutboundValue(messages, extraSecrets || environmentSecrets());
    onOutbound?.({ providerId: this.id, host: 'cli:claude', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: ['cli:telemetry-disabled'], secretsRedacted: cleaned.count, blocked: false });
    const list = Array.isArray(cleaned.value) ? cleaned.value : [{ role: 'user', content: String(cleaned.value || '') }];
    const sys = [
      'CRITICAL: Planner/advisory text-only call. Do not invoke any native tools.',
      ...list.filter(m => m?.role === 'system').map(m => String(m.content || ''))
    ].filter(Boolean).join('\n\n');
    const userPrompt = list.filter(m => m?.role !== 'system').map(m => `${String(m?.role || 'user').toUpperCase()}:\n${String(m?.content || '')}`).join('\n\n') || 'Continue.';
    const working = await fs.mkdtemp(path.join(tmpdir(), 'g0d-claude-draft-'));
    try {
      const args = [
        '--print', '--output-format', 'stream-json', '--verbose',
        '--no-session-persistence', '--tools', '', '--disable-slash-commands', '--no-chrome',
        '--permission-mode', 'dontAsk', '--setting-sources', '',
        '--settings', JSON.stringify({ disableAllHooks: true, enabledPlugins: {} }),
        '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
        '--max-turns', '2', '--system-prompt', sys
      ];
      if (this.model) args.push('--model', this.model);
      const output = await runClaudePlanner(this, { args, cwd: working, signal, turnTimeoutMs: 60000, input: userPrompt });
      const events = output.split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
      const result = events.findLast(e => e.type === 'result');
      if (result && (result.is_error || (result.subtype && result.subtype !== 'success'))) {
        const resHint = String(result.result || result.error || '');
        const isRate = /rate\s*limit|too many requests|429|overloaded|529|capacity/i.test(resHint);
        return { type: 'error', code: isRate ? 'rate_limit' : 'provider_configuration', message: isRate ? 'Claude Code hit a temporary rate limit.' : 'Claude Code could not complete the advisory request.', retryable: isRate };
      }
      const assistantText = events.flatMap(e => e.message?.content || []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('').trim();
      const text = (typeof result?.result === 'string' && result.result.trim()) ? result.result.trim() : assistantText;
      return { type: 'message', text, finish: 'done', usage: result?.usage || null, model: this.model || 'claude-cli-default' };
    } catch (err) {
      return { type: 'error', code: err?.code || 'provider_error', message: err?.message || 'Claude Code CLI draft failed.', retryable: Boolean(err?.retryable) };
    } finally {
      await fs.rm(working, { recursive: true, force: true });
    }
  }
}

// Subscription bridges inherit only process basics, CLI-owned auth locations and
// owner-configured transport settings. API credentials never cross providers,
// and vendor CLI telemetry/update beacons are forcibly disabled.
export function cliEnvironment(environment=process.env) {
  const names=new Set(['HOME','USER','LOGNAME','PATH','SHELL','TMPDIR','TMP','TEMP','LANG','TZ','TERM','COLORTERM','NO_COLOR','CI','CODEX_HOME','CLAUDE_CONFIG_DIR','GEMINI_CONFIG_DIR','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','GH_CONFIG_DIR','COPILOT_CONFIG_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','SYSTEMROOT','SystemRoot','WINDIR','COMSPEC','USERPROFILE','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH','PATHEXT','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']);
  const base=Object.fromEntries(Object.entries(environment).filter(([name])=>names.has(name)||/^LC_[A-Z_]+$/.test(name)));
  return { ...base, ...CLI_NO_TELEMETRY_ENV };
}

// Do not let an API-key environment override the explicitly selected subscription login.
export function claudeSubscriptionEnvironment(environment=process.env) {
  const env=cliEnvironment(environment);
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_SIMPLE','CLAUDECODE'])delete env[key];
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
  return env;
}

export function geminiSubscriptionEnvironment(environment=process.env) {
  const env=cliEnvironment(environment);
  for(const key of ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_GENAI_USE_VERTEXAI','ANTHROPIC_API_KEY','OPENAI_API_KEY'])delete env[key];
  return env;
}

export function antigravitySubscriptionEnvironment(environment=process.env) {
  const env=cliEnvironment(environment);
  for(const key of ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_GENAI_USE_VERTEXAI','ANTHROPIC_API_KEY','OPENAI_API_KEY'])delete env[key];
  return env;
}

export function copilotSubscriptionEnvironment(environment=process.env) {
  const env=cliEnvironment(environment);
  for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY'])delete env[key];
  return env;
}

export function parsePlannerDecisionEnvelope(rawText, tools, providerLabel = 'CLI bridge') {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw Object.assign(new Error(`No structured response from ${providerLabel}`), { code: 'tool_protocol' });
  }
  const trimmed = rawText.trim();
  const candidates = [trimmed];
  for (const m of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (m[1]?.trim()) candidates.push(m[1].trim());
  }
  const firstBrace = trimmed.indexOf('{'), lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  const isValidShape = v => Boolean(
    v && typeof v === 'object' && !Array.isArray(v)
    && ['tool', 'message'].includes(v.type)
    && Array.isArray(v.calls)
    && typeof v.text === 'string'
    && ['continue', 'done', 'refusal'].includes(v.finish)
    && !Object.keys(v).some(key => !['type', 'calls', 'text', 'finish'].includes(key))
  );
  let value = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isValidShape(parsed)) { value = parsed; break; }
      if (!value) value = parsed;
    } catch {}
  }
  if (!isValidShape(value)) {
    throw Object.assign(new Error(`${providerLabel} returned an invalid decision envelope`), { code: 'tool_protocol' });
  }
  if ((value.type === 'tool' && (!value.calls.length || value.finish !== 'continue'))
    || (value.type === 'message' && value.calls.length)) {
    throw Object.assign(new Error(`${providerLabel} returned inconsistent decision fields`), { code: 'tool_protocol' });
  }
  return value.type === 'tool'
    ? { type: 'tool', calls: normalizeCalls(value.calls, toolAliases(tools), tools) }
    : { type: 'message', text: value.text || '', finish: value.finish || 'done' };
}

function runSubprocessPlanner(owner, { args, cwd, signal, turnTimeoutMs, timeoutOverrideMs, input, env, label }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error(`${label} bridge cancelled`), { code: 'cancelled' })); return; }
    const child = spawn(owner.binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env, detached: process.platform !== 'win32' });
    const outChunks = [];
    let outBytes = 0, settled = false, closed = false, terminating = false, killTimer, resolveExit;
    const exited = new Promise(done => { resolveExit = done; });
    const kill = () => {
      if (terminating || closed || !Number.isInteger(child.pid)) return;
      terminating = true;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }, 500);
    };
    const record = { child, exited, terminate: kill };
    owner.children.add(record);
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { kill(); done(Object.assign(new Error(`${label} bridge cancelled`), { code: 'cancelled' })); };
    const cliTimeoutMs = Number.isFinite(timeoutOverrideMs) && timeoutOverrideMs > 0
      ? timeoutOverrideMs
      : (Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0 ? Math.max(owner.timeoutMs, turnTimeoutMs) : owner.timeoutMs);
    const timer = setTimeout(() => { kill(); done(Object.assign(new Error(`${label} bridge timed out`), { code: 'ETIMEDOUT' })); }, cliTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => done(Object.assign(new Error(`${label} CLI could not start. Check its installation.`), { code: 'provider_configuration', retryable: false })));
    child.stdout.on('data', chunk => {
      outBytes += chunk.byteLength;
      if (outBytes > 16 * 1024 * 1024) {
        kill();
        done(Object.assign(new Error(`${label} bridge output exceeded its limit`), { code: 'tool_protocol' }));
        return;
      }
      outChunks.push(chunk);
    });
    // Capture bounded stderr ONLY for internal error classification — never forward raw stderr to tasks/UI/logs.
    let errSnippet = '';
    child.stderr.on('data', chunk => {
      if (errSnippet.length < 4096) errSnippet += chunk.toString('utf8');
    });
    child.on('close', code => {
      closed = true; clearTimeout(killTimer); owner.children.delete(record); resolveExit();
      if (code === 0) {
        done(null, Buffer.concat(outChunks).toString('utf8'));
        return;
      }
      const lowerErr = errSnippet.toLowerCase();
      if (/quota\s+reached|third-party\s+quota|daily\s+limit\s+reached|resets?\s+in\s+\d+\s*[mh]/i.test(lowerErr)) {
        const resetMatch = errSnippet.match(/resets?\s+in\s+[0-9]+[mh](?:[0-9]+[ms])?/i);
        const resetHint = resetMatch ? ` (${resetMatch[0]})` : '';
        done(Object.assign(new Error(`${label} CLI quota reached${resetHint}. Switch models or wait before retrying.`), { code: 'quota_exhausted', retryable: true, quotaExhausted: true, retryAfterMs: 300000 }));
      } else if (/429|rate[\s_-]?limit|quota|too many requests|resource_exhausted|overloaded|temporarily unavailable/i.test(lowerErr)) {
        done(Object.assign(new Error(`${label} CLI is temporarily rate-limited or overloaded.`), { code: 'rate_limit', retryable: true, retryAfterMs: 2500 }));
      } else if (/not logged in|unauthenticated|sign[\s-]?in|login required|expired token|invalid credentials/i.test(lowerErr)) {
        const hint = label === 'Antigravity' ? ' Run `agy login` to re-authenticate.' : '';
        done(Object.assign(new Error(`${label} CLI authentication required.${hint}`), { code: 'provider_configuration', retryable: false }));
      } else {
        done(Object.assign(new Error(`${label} CLI could not complete the request. Check CLI sign-in, model access and usage limits.`), { code: 'provider_configuration', retryable: false }));
      }
    });
    child.stdin.on('error', () => {});
    if (signal?.aborted) { abort(); return; }
    child.stdin.end(input);
  });
}

/** Subscription-authenticated Google Gemini CLI planner. CLI owns OAuth; the broker owns effects. */
export class GeminiCliProvider extends CodexProvider {
  constructor({ id = 'gemini-cli', label = 'Gemini CLI · CLI default', binary = process.env.G0D_GEMINI_BINARY || 'gemini', timeoutMs = 120000, model, environment = process.env, subscriptionId = 'gemini-cli', cliSettings = {} } = {}) {
    super({ id, label, binary, timeoutMs, model, environment, subscriptionId, cliSettings });
    this.kind = 'gemini-cli';
    this.tier = inferProviderTier({ id, model: model || 'gemini-2.5-pro' });
    this.accounting = 'CLI turns and reported stats; underlying provider attempts are opaque';
  }
  async turn(context, { signal, turnTimeoutMs, privacy = DEFAULT_PRIVACY_SETTINGS, onOutbound, extraSecrets } = {}) {
    if (this.closed) throw Object.assign(new Error('Gemini CLI provider is closed'), { code: 'PROVIDER_CLOSED', retryable: false });
    if (signal?.aborted) throw Object.assign(new Error('Gemini CLI bridge cancelled'), { code: 'cancelled' });
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: 'cli:gemini', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const cleaned = privacy.redactOutboundSecrets === false ? { value: context, count: 0 } : redactOutboundValue(context, extraSecrets || environmentSecrets());
    context = cleaned.value;
    onOutbound?.({ providerId: this.id, host: 'cli:gemini', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: ['cli:telemetry-disabled'], secretsRedacted: cleaned.count, blocked: false });
    const tools = context.tools ?? canonicalTools;
    const working = await fs.mkdtemp(path.join(tmpdir(), 'g0d-gemini-planner-'));
    try {
      if (this.closed) throw Object.assign(new Error('Gemini CLI provider is closed'), { code: 'PROVIDER_CLOSED', retryable: false });
      const directive = 'Return ONLY one valid JSON object matching the next-action decision envelope (no markdown fences, no commentary). Do not invoke any native Gemini CLI tools.';
      const args = ['--prompt', directive, '--output-format', 'json'];
      if (this.model) args.push('--model', this.model);
      const stdinPayload = `${compilePrompt({ ...context, tools })}\n\n` +
        `This is a planner-only bridge. DO NOT invoke any Gemini CLI tools. Return ONLY raw JSON matching:\n` +
        `{"type":"tool"|"message","calls":[{"id":"unique","name":"tool.name","arguments":"JSON string"}],"text":"","finish":"continue"|"done"|"refusal"}\n` +
        `Available tools: ${JSON.stringify(tools)}\n` +
        `For tool actions set type="tool", calls=[...], text="", finish="continue". For final replies set type="message", calls=[], text="summary", finish="done".`;
      const env = geminiSubscriptionEnvironment(cliEnvironments.get(this));
      const output = await runSubprocessPlanner(this, { args, cwd: working, signal, turnTimeoutMs, input: stdinPayload, env, label: 'Gemini' });
      let envelopeText = output, usage = null, parsed = null;
      const trimmedOut = output.trim();
      try { parsed = JSON.parse(trimmedOut); } catch {
        const fb = trimmedOut.indexOf('{'), lb = trimmedOut.lastIndexOf('}');
        if (fb >= 0 && lb > fb) { try { parsed = JSON.parse(trimmedOut.slice(fb, lb + 1)); } catch {} }
      }
      if (parsed && typeof parsed === 'object') {
        if ((parsed.stats?.tools?.totalCalls || 0) > 0) {
          throw Object.assign(new Error('Planner-only Gemini CLI bridge attempted an internal tool; response rejected'), { code: 'tool_protocol' });
        }
        if (typeof parsed.response === 'string') envelopeText = parsed.response;
        else if (typeof parsed.text === 'string' && !parsed.type) envelopeText = parsed.text;
        if (parsed.stats) usage = parsed.stats;
      }
      const decision = parsePlannerDecisionEnvelope(envelopeText, tools, 'Gemini CLI');
      return { ...decision, usage, model: this.model || 'gemini-cli-default', evidenceKind: 'live_gemini_cli', accounting: this.accounting };
    } finally { await fs.rm(working, { recursive: true, force: true }); }
  }
  async draft(messages = [], signal, _maxTokens = 1000, _params = {}, { privacy = DEFAULT_PRIVACY_SETTINGS, onOutbound, extraSecrets } = {}) {
    if (this.closed) return { type: 'error', code: 'PROVIDER_CLOSED', message: 'Gemini CLI provider is closed.', retryable: false };
    if (signal?.aborted) return { type: 'error', code: 'cancelled', message: 'Gemini CLI request cancelled.', retryable: false };
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: 'cli:gemini', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const cleaned = privacy.redactOutboundSecrets === false ? { value: messages, count: 0 } : redactOutboundValue(messages, extraSecrets || environmentSecrets());
    onOutbound?.({ providerId: this.id, host: 'cli:gemini', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: ['cli:telemetry-disabled'], secretsRedacted: cleaned.count, blocked: false });
    const promptText = [
      'CRITICAL: Planner/advisory text-only call. DO NOT invoke any Gemini CLI built-in tools.',
      ...(Array.isArray(cleaned.value) ? cleaned.value.map(m => `${String(m?.role || 'user').toUpperCase()}:\n${String(m?.content || '')}`) : [String(cleaned.value || '')])
    ].join('\n\n');
    const working = await fs.mkdtemp(path.join(tmpdir(), 'g0d-gemini-draft-'));
    try {
      const directive = 'Read the advisory prompt from stdin and respond directly. Do not invoke any native Gemini CLI tools.';
      const args = ['--prompt', directive, '--output-format', 'json'];
      if (this.model) args.push('--model', this.model);
      const env = geminiSubscriptionEnvironment(cliEnvironments.get(this));
      const output = await runSubprocessPlanner(this, { args, cwd: working, signal, timeoutOverrideMs: 60000, input: promptText, env, label: 'Gemini' });
      let text = output.trim(), parsed = null;
      try { parsed = JSON.parse(text); } catch {
        const fb = text.indexOf('{'), lb = text.lastIndexOf('}');
        if (fb >= 0 && lb > fb) { try { parsed = JSON.parse(text.slice(fb, lb + 1)); } catch {} }
      }
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.response === 'string') text = parsed.response;
        else if (typeof parsed.text === 'string') text = parsed.text;
      }
      return { type: 'message', text, finish: 'done', usage: parsed?.stats || null, model: this.model || 'gemini-cli-default' };
    } catch (err) {
      return { type: 'error', code: err?.code || 'provider_error', message: err?.message || 'Gemini CLI draft failed.', retryable: Boolean(err?.retryable) };
    } finally {
      await fs.rm(working, { recursive: true, force: true });
    }
  }
}

function compactToolCatalog(tools = []) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

function antigravityContractSignature(context) {
  const task = context.task || {};
  // Keep overseerGuidance and probeProgress out of the session-busting hash — they are
  // already delivered in buildAntigravityDeltaPayload so Neon retains its warm KV-cache!
  return createHash('sha256').update(JSON.stringify({
    objective: task.objective || '',
    constraints: task.constraints || [],
    planMode: Boolean(task.planMode),
    effort: task.effort || 'medium',
    execution: task.execution || null,
    checks: (task.checks || []).map(c => ({ name: c?.name, command: c?.command })),
    persona: task.persona || 'plinian',
  })).digest('hex');
}

function buildAntigravityDeltaPayload(context, cached) {
  const lastEventSeq = cached?.lastEventSeq || 0;
  const prevFollowupsCount = cached?.followupsCount || 0;
  const prevFiles = cached?.fileSnapshots instanceof Map ? cached.fileSnapshots : new Map();
  const task = context.task || {};
  const history = Array.isArray(context.history) ? context.history : [];
  const deltaEvents = history
    .filter(e => e && Number.isInteger(e.seq) && e.seq > lastEventSeq && !['model.request', 'model.response', 'tool.started'].includes(e.type))
    .map(({ seq, type, data }) => ({ seq, type, data }));
  const fileIndex = (context.files || []).map(f => {
    const prev = prevFiles.get(f.path);
    const includeContent = typeof f.content === 'string' && (!prev || prev.sha256 !== f.sha256 || !prev.hasContent);
    return {
      path: f.path,
      sha256: f.sha256,
      bytes: f.bytes,
      ...(includeContent ? { content: f.content } : {}),
    };
  });
  const followups = Array.isArray(task.followups) ? task.followups : [];
  const newFollowups = followups.slice(prevFollowupsCount);
  const delta = {
    task: {
      id: task.id,
      calls: task.calls,
      remainingCalls: context.remainingCalls,
      snapshotHash: context.snapshotHash,
      verification: task.verificationSummary || null,
      probeProgress: task.probeProgress || null,
    },
    eventsSinceLastTurn: deltaEvents,
    currentFiles: fileIndex,
    ...(Array.isArray(task.todos) && task.todos.length ? { todos: task.todos } : {}),
    ...(newFollowups.length ? { newFollowups } : {}),
    ...(task.overseerGuidance ? { overseerGuidance: String(task.overseerGuidance).slice(0, 600) } : {}),
  };
  return `Continue the task. CRITICAL: planner-only JSON bridge — DO NOT invoke any Antigravity CLI built-in tools. Return ONLY one raw JSON decision envelope (no markdown fences, no prose): {"type":"tool"|"message","calls":[{"id":"unique","name":"tool.name","arguments":"JSON string"}],"text":"","finish":"continue"|"done"|"refusal"}.\n` +
    `EFFICIENCY: Calls in calls:[...] execute sequentially in order — batch repo.write/repo.patch AND verification (process.run / check.run) in ONE turn. Omit expectedHash on repo.write. Clean up any temporary test files inside the same shell command. Once verified, immediately return type="message", finish="done".\n\n` +
    `Delta since your last turn (JSON):\n${JSON.stringify(delta)}`;
}

/** Subscription-authenticated Google Antigravity CLI (agy) planner. CLI owns Google auth; the broker owns effects. */
export class AntigravityCliProvider extends CodexProvider {
  constructor({ id = 'antigravity-cli', label = 'Google Antigravity (agy) · CLI default', binary = process.env.G0D_ANTIGRAVITY_BINARY || 'agy', timeoutMs = 180000, model, environment = process.env, subscriptionId = 'antigravity-cli', cliSettings = {} } = {}) {
    super({ id, label, binary, timeoutMs, model, environment, subscriptionId, cliSettings });
    this.kind = 'antigravity-cli';
    this.tier = inferProviderTier({ id, model: model || 'gemini-4-neon-high' });
    this.accounting = 'Antigravity CLI turns and reported usage; underlying provider attempts are opaque';
    this.sessions = new Map();
    this.inFlightSessions = new Set();
  }
  close() {
    this.sessions.clear();
    this.inFlightSessions.clear();
    return super.close();
  }
  async draft(messages = [], signal, _maxTokens = 1000, _params = {}, { privacy = DEFAULT_PRIVACY_SETTINGS, onOutbound, extraSecrets } = {}) {
    if (this.closed) return { type: 'error', code: 'PROVIDER_CLOSED', message: 'Antigravity CLI provider is closed.', retryable: false };
    if (signal?.aborted) return { type: 'error', code: 'cancelled', message: 'Antigravity CLI request cancelled.', retryable: false };
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: 'cli:antigravity', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const cleaned = privacy.redactOutboundSecrets === false ? { value: messages, count: 0 } : redactOutboundValue(messages, extraSecrets || environmentSecrets());
    onOutbound?.({ providerId: this.id, host: 'cli:antigravity', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: ['cli:telemetry-disabled'], secretsRedacted: cleaned.count, blocked: false });
    const promptText = [
      'CRITICAL: Planner/advisory text-only call. DO NOT invoke any Antigravity CLI built-in tools.',
      ...(Array.isArray(cleaned.value) ? cleaned.value.map(m => `${String(m?.role || 'user').toUpperCase()}:\n${String(m?.content || '')}`) : [String(cleaned.value || '')])
    ].join('\n\n');
    const working = await fs.mkdtemp(path.join(tmpdir(), 'g0d-agy-draft-'));
    try {
      const env = antigravitySubscriptionEnvironment(cliEnvironments.get(this));
      const args = ['--output-format', 'json', '--disable-slash-commands', '--sandbox'];
      if (this.model) args.push('--model', this.model);
      const output = await runSubprocessPlanner(this, { args, cwd: working, signal, timeoutOverrideMs: 60000, input: promptText, env, label: 'Antigravity' });
      let text = output.trim();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {
        const fb = text.indexOf('{'), lb = text.lastIndexOf('}');
        if (fb >= 0 && lb > fb) { try { parsed = JSON.parse(text.slice(fb, lb + 1)); } catch {} }
      }
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.status === 'string' && parsed.status && parsed.status !== 'SUCCESS') {
          return { type: 'error', code: 'provider_configuration', message: `Antigravity CLI returned status ${String(parsed.status).slice(0, 40)}`, retryable: false };
        }
        if (typeof parsed.response === 'string') text = parsed.response;
        else if (typeof parsed.text === 'string') text = parsed.text;
      }
      return { type: 'message', text, finish: 'done', usage: parsed?.usage || null, model: this.model || 'antigravity-cli-default' };
    } catch (err) {
      return { type: 'error', code: err?.code || 'provider_error', message: err?.message || 'Antigravity CLI draft failed.', retryable: Boolean(err?.retryable) };
    } finally {
      await fs.rm(working, { recursive: true, force: true });
    }
  }
  async turn(context, { signal, turnTimeoutMs, privacy = DEFAULT_PRIVACY_SETTINGS, onOutbound, extraSecrets } = {}) {
    if (this.closed) throw Object.assign(new Error('Antigravity CLI provider is closed'), { code: 'PROVIDER_CLOSED', retryable: false });
    if (signal?.aborted) throw Object.assign(new Error('Antigravity CLI bridge cancelled'), { code: 'cancelled' });
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: 'cli:antigravity', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const cleaned = privacy.redactOutboundSecrets === false ? { value: context, count: 0 } : redactOutboundValue(context, extraSecrets || environmentSecrets());
    context = cleaned.value;
    onOutbound?.({ providerId: this.id, host: 'cli:antigravity', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: ['cli:telemetry-disabled'], secretsRedacted: cleaned.count, blocked: false });
    const tools = context.tools ?? canonicalTools;
    const taskId = typeof context.task?.id === 'string' && context.task.id ? context.task.id : null;
    const history = Array.isArray(context.history) ? context.history : [];
    const maxEventSeq = history.reduce((m, e) => (Number.isInteger(e?.seq) && e.seq > m ? e.seq : m), 0);
    const strategy = context.strategy || 'continue';
    const contractVersion = context.task?.contractVersion ?? 1;
    const recoveries = context.task?.recoveries ?? 0;
    const compactedBeforeSeq = context.task?.workingSummary?.compactedBeforeSeq || 0;
    const toolSig = tools.map(t => t.name).join(',');
    const contractSig = antigravityContractSignature(context);
    const validConvId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);

    const followups = Array.isArray(context.task?.followups) ? context.task.followups : [];
    const followupsPrefixHash = count => createHash('sha256').update(JSON.stringify(followups.slice(0, count).map(f => ({ id: f?.id, message: f?.message })))).digest('hex');

    // Only stateful multi-turn tasks with durable event history participate in session reuse.
    // Stateless subagent/overseer/compactor turns (history: []) and overlapping calls never touch this.sessions.
    const canManageSession = Boolean(taskId && history.length > 0 && maxEventSeq > 0 && !this.inFlightSessions.has(taskId));
    if (canManageSession) this.inFlightSessions.add(taskId);

    const cached = canManageSession ? this.sessions.get(taskId) : null;
    const followupsAppendOnly = Boolean(
      cached
      && followups.length >= (cached.followupsCount || 0)
      && followupsPrefixHash(cached.followupsCount || 0) === cached.followupsHash
    );
    const canReuseSession = Boolean(
      canManageSession
      && cached
      && validConvId(cached.conversationId)
      && cached.strategy === strategy
      && contractVersion >= cached.contractVersion
      && followupsAppendOnly
      && cached.recoveries === recoveries
      && cached.toolSig === toolSig
      && cached.contractSig === contractSig
      && cached.lastEventSeq > 0
      && maxEventSeq >= cached.lastEventSeq
      && compactedBeforeSeq <= cached.lastEventSeq
    );
    if (canManageSession && cached && !canReuseSession) {
      this.sessions.delete(taskId);
    }

    const turnStartedAt = Date.now();
    const turnBudgetMs = Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0 ? Math.max(this.timeoutMs, turnTimeoutMs) : this.timeoutMs;
    const working = await fs.mkdtemp(path.join(tmpdir(), 'g0d-agy-planner-'));
    try {
      if (this.closed) throw Object.assign(new Error('Antigravity CLI provider is closed'), { code: 'PROVIDER_CLOSED', retryable: false });
      const env = antigravitySubscriptionEnvironment(cliEnvironments.get(this));
      const buildArgs = conversationId => {
        // Omit --print so agy reads the complete planner prompt directly from stdin (avoids argv prompt leaks & E2BIG).
        const args = ['--output-format', 'json', '--disable-slash-commands', '--sandbox'];
        if (this.model) args.push('--model', this.model);
        const effort = this.cliSettings?.reasoningEffort;
        if (effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) args.push('--effort', effort);
        if (conversationId) args.push('--conversation', conversationId);
        return args;
      };
      const buildFullPayload = () =>
        `CRITICAL: You are running inside a planner-only JSON bridge. DO NOT invoke any Antigravity CLI built-in tools (no read_file, write_file, run_command, etc.). Return ONLY one raw JSON object matching the decision envelope below (no markdown fences, no prose).\n` +
        `EFFICIENCY RULES:\n` +
        `- Files already shown with content in your workspace snapshot below are ALREADY loaded — do NOT waste a turn calling repo.list or repo.read on them.\n` +
        `- Calls in calls:[...] execute sequentially in order: batch all independent repo.write/repo.patch edits AND your verification process.run (or check.run if configured) in the SAME type="tool" turn whenever possible.\n` +
        `- On repo.write, OMIT expectedHash (the broker tracks file hashes automatically).\n` +
        `- If you run ad-hoc verification commands via process.run, use inline scripts or clean up any temporary test/binary files inside the SAME shell command. Once verification passes cleanly, immediately return type="message", finish="done".\n\n` +
        `${compilePrompt({ ...context, tools })}\n\n` +
        `Return ONLY raw JSON matching:\n` +
        `{"type":"tool"|"message","calls":[{"id":"unique","name":"tool.name","arguments":"JSON string"}],"text":"","finish":"continue"|"done"|"refusal"}\n` +
        `Available tools: ${JSON.stringify(compactToolCatalog(tools))}\n` +
        `For tool actions set type="tool", calls=[...], text="", finish="continue". For final replies set type="message", calls=[], text="summary", finish="done".`;

      const invokeAndParse = async (conversationId, timeoutOverrideMs = null) => {
        const args = buildArgs(conversationId);
        const stdinPayload = conversationId
          ? buildAntigravityDeltaPayload(context, cached)
          : buildFullPayload();
        const output = await runSubprocessPlanner(this, { args, cwd: working, signal, turnTimeoutMs, timeoutOverrideMs, input: stdinPayload, env, label: 'Antigravity' });
        let envelopeText = output, usage = null, parsed = null;
        const trimmedOut = output.trim();
        try { parsed = JSON.parse(trimmedOut); } catch {
          const fb = trimmedOut.indexOf('{'), lb = trimmedOut.lastIndexOf('}');
          if (fb >= 0 && lb > fb) { try { parsed = JSON.parse(trimmedOut.slice(fb, lb + 1)); } catch {} }
        }
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.status === 'string' && parsed.status && parsed.status !== 'SUCCESS') {
            const safeStatus = String(parsed.status).replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 40) || 'ERROR';
            throw Object.assign(new Error(`Antigravity CLI returned status ${safeStatus}`), { code: 'provider_configuration', retryable: false });
          }
          if (Number(parsed.num_turns) > 1 && !parsed.structured_output) {
            throw Object.assign(new Error('Planner-only Antigravity CLI bridge attempted an internal tool turn; response rejected'), { code: 'tool_protocol' });
          }
          if (parsed.structured_output && typeof parsed.structured_output === 'object') envelopeText = JSON.stringify(parsed.structured_output);
          else if (typeof parsed.response === 'string') envelopeText = parsed.response;
          else if (typeof parsed.text === 'string' && !parsed.type) envelopeText = parsed.text;
          if (parsed.usage && typeof parsed.usage === 'object') usage = parsed.usage;
        }
        const decision = parsePlannerDecisionEnvelope(envelopeText, tools, 'Antigravity CLI');
        const nextConversationId = validConvId(parsed?.conversation_id) ? parsed.conversation_id : conversationId;
        return { decision, usage, nextConversationId };
      };

      let result;
      if (canReuseSession) {
        try {
          result = await invokeAndParse(cached.conversationId);
        } catch (err) {
          this.sessions.delete(taskId);
          const remainingMs = turnBudgetMs - (Date.now() - turnStartedAt);
          if (err?.code === 'cancelled' || err?.code === 'PROVIDER_CLOSED' || err?.code === 'ETIMEDOUT' || signal?.aborted || this.closed || remainingMs < 15000) throw err;
          // Warm session expired or errored — fall back transparently to a fresh full-context turn within remaining timeout budget.
          result = await invokeAndParse(null, remainingMs);
        }
      } else {
        result = await invokeAndParse(null);
      }

      if (canManageSession) {
        if (result.decision.finish === 'refusal' || !validConvId(result.nextConversationId)) {
          this.sessions.delete(taskId);
        } else {
          const fileSnapshots = new Map(
            (context.files || []).map(f => [f.path, { sha256: f.sha256, hasContent: typeof f.content === 'string' }])
          );
          this.sessions.set(taskId, {
            conversationId: result.nextConversationId,
            lastEventSeq: maxEventSeq,
            followupsCount: followups.length,
            followupsHash: followupsPrefixHash(followups.length),
            fileSnapshots,
            strategy,
            contractVersion,
            recoveries,
            toolSig,
            contractSig,
          });
          // Bound session cache size to prevent unbounded growth in long-lived servers
          if (this.sessions.size > 200) {
            const oldestKey = this.sessions.keys().next().value;
            if (oldestKey && oldestKey !== taskId) this.sessions.delete(oldestKey);
          }
        }
      }

      return { ...result.decision, usage: result.usage, model: this.model || 'antigravity-cli-default', evidenceKind: 'live_antigravity_cli', accounting: this.accounting };
    } finally {
      if (canManageSession) this.inFlightSessions.delete(taskId);
      await fs.rm(working, { recursive: true, force: true });
    }
  }
}

/** Subscription-authenticated GitHub Copilot CLI planner. CLI owns GitHub auth; the broker owns effects. */
export class CopilotCliProvider extends CodexProvider {
  constructor({ id = 'copilot-cli', label = 'GitHub Copilot · CLI default', binary = process.env.G0D_COPILOT_BINARY || 'copilot', timeoutMs = 120000, model, environment = process.env, subscriptionId = 'copilot-cli', cliSettings = {} } = {}) {
    super({ id, label, binary, timeoutMs, model, environment, subscriptionId, cliSettings });
    this.kind = 'copilot-cli';
    this.tier = inferProviderTier({ id, model: model || 'gpt-5' });
    this.accounting = 'CLI turns; underlying provider attempts are opaque';
  }
  async turn(context, { signal, turnTimeoutMs, privacy = DEFAULT_PRIVACY_SETTINGS, onOutbound, extraSecrets } = {}) {
    if (this.closed) throw Object.assign(new Error('GitHub Copilot provider is closed'), { code: 'PROVIDER_CLOSED', retryable: false });
    if (signal?.aborted) throw Object.assign(new Error('GitHub Copilot bridge cancelled'), { code: 'cancelled' });
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: 'cli:copilot', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const cleaned = privacy.redactOutboundSecrets === false ? { value: context, count: 0 } : redactOutboundValue(context, extraSecrets || environmentSecrets());
    context = cleaned.value;
    onOutbound?.({ providerId: this.id, host: 'cli:copilot', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: ['cli:telemetry-disabled'], secretsRedacted: cleaned.count, blocked: false });
    const tools = context.tools ?? canonicalTools;
    const working = await fs.mkdtemp(path.join(tmpdir(), 'g0d-copilot-planner-'));
    try {
      if (this.closed) throw Object.assign(new Error('GitHub Copilot provider is closed'), { code: 'PROVIDER_CLOSED', retryable: false });
      const promptText = `${compilePrompt({ ...context, tools })}\n\n` +
        `This is a planner-only bridge. DO NOT invoke any Copilot tools. Return ONLY one raw JSON object (no markdown fences) matching:\n` +
        `{"type":"tool"|"message","calls":[{"id":"unique","name":"tool.name","arguments":"JSON string"}],"text":"","finish":"continue"|"done"|"refusal"}\n` +
        `Available tools: ${JSON.stringify(tools)}\n` +
        `For tool actions set type="tool", calls=[...], text="", finish="continue". For final replies set type="message", calls=[], text="summary", finish="done".`;
      // Intentionally omit --allow-all-tools so Copilot cannot execute local tools directly.
      // Pipe the full prompt over stdin (with a short -p directive) to avoid argv E2BIG crashes & ps aux leaks.
      const directive = 'Read the complete planner prompt from stdin and return ONLY the single raw JSON decision envelope.';
      const args = ['-p', directive, '-s'];
      if (this.model) args.push('--model', this.model);
      const env = copilotSubscriptionEnvironment(cliEnvironments.get(this));
      const output = await runSubprocessPlanner(this, { args, cwd: working, signal, turnTimeoutMs, input: promptText, env, label: 'GitHub Copilot' });
      const decision = parsePlannerDecisionEnvelope(output, tools, 'GitHub Copilot CLI');
      return { ...decision, usage: null, model: this.model || 'copilot-cli-default', evidenceKind: 'live_copilot_cli', accounting: this.accounting };
    } finally { await fs.rm(working, { recursive: true, force: true }); }
  }
  async draft(messages = [], signal, _maxTokens = 1000, _params = {}, { privacy = DEFAULT_PRIVACY_SETTINGS, onOutbound, extraSecrets } = {}) {
    if (this.closed) return { type: 'error', code: 'PROVIDER_CLOSED', message: 'GitHub Copilot provider is closed.', retryable: false };
    if (signal?.aborted) return { type: 'error', code: 'cancelled', message: 'GitHub Copilot request cancelled.', retryable: false };
    const gate = checkProviderPrivacyAllowed(this, privacy);
    if (!gate.allowed) {
      onOutbound?.({ providerId: this.id, host: 'cli:copilot', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: [], secretsRedacted: 0, blocked: true, reason: gate.message });
      return { type: 'error', code: gate.code, message: gate.message, retryable: false };
    }
    const cleaned = privacy.redactOutboundSecrets === false ? { value: messages, count: 0 } : redactOutboundValue(messages, extraSecrets || environmentSecrets());
    onOutbound?.({ providerId: this.id, host: 'cli:copilot', protocol: this.kind, zdrClass: gate.posture.zdrClass, zdrFlags: ['cli:telemetry-disabled'], secretsRedacted: cleaned.count, blocked: false });
    const promptText = [
      'CRITICAL: Planner/advisory text-only call. DO NOT invoke any Copilot tools.',
      ...(Array.isArray(cleaned.value) ? cleaned.value.map(m => `${String(m?.role || 'user').toUpperCase()}:\n${String(m?.content || '')}`) : [String(cleaned.value || '')])
    ].join('\n\n');
    const working = await fs.mkdtemp(path.join(tmpdir(), 'g0d-copilot-draft-'));
    try {
      const directive = 'Read the advisory prompt from stdin and respond directly. Do not invoke any Copilot tools.';
      const args = ['-p', directive, '-s'];
      if (this.model) args.push('--model', this.model);
      const env = copilotSubscriptionEnvironment(cliEnvironments.get(this));
      const output = await runSubprocessPlanner(this, { args, cwd: working, signal, timeoutOverrideMs: 60000, input: promptText, env, label: 'GitHub Copilot' });
      return { type: 'message', text: output.trim(), finish: 'done', usage: null, model: this.model || 'copilot-cli-default' };
    } catch (err) {
      return { type: 'error', code: err?.code || 'provider_error', message: err?.message || 'GitHub Copilot CLI draft failed.', retryable: Boolean(err?.retryable) };
    } finally {
      await fs.rm(working, { recursive: true, force: true });
    }
  }
}

function runClaudePlanner(owner,{args,cwd,signal,turnTimeoutMs,input}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(Object.assign(new Error('Claude Code bridge cancelled'),{code:'cancelled'}));return;}
    const child=spawn(owner.binary,args,{cwd,stdio:['pipe','pipe','pipe'],env:claudeSubscriptionEnvironment(cliEnvironments.get(owner)),detached:process.platform!=='win32'});
    const outChunks = [];
    let outBytes = 0, errSnippet = '', settled = false, closed = false, terminating = false, killTimer, resolveExit;
    const exited=new Promise(done=>{resolveExit=done;});
    const kill=()=>{
      if(terminating||closed||!Number.isInteger(child.pid))return;terminating=true;
      try{if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{}
      killTimer=setTimeout(()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},500);
    };
    const record={child,exited,terminate:kill};owner.children.add(record);
    const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort=()=>{kill();done(Object.assign(new Error('Claude Code bridge cancelled'),{code:'cancelled'}));};
    const cliTimeoutMs = Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0 ? Math.max(owner.timeoutMs, turnTimeoutMs) : owner.timeoutMs;
    const timer=setTimeout(()=>{kill();done(Object.assign(new Error('Claude Code bridge timed out'),{code:'ETIMEDOUT'}));},cliTimeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    child.on('error',()=>done(Object.assign(new Error('Claude Code CLI could not start. Check its installation.'),{code:'provider_configuration',retryable:false})));
    child.stdout.on('data',chunk=>{
      outBytes += chunk.byteLength;
      if (outBytes > 16 * 1024 * 1024) { kill(); done(Object.assign(new Error('Claude Code bridge output exceeded its limit'),{code:'tool_protocol'})); return; }
      outChunks.push(chunk);
    });
    // Classify stderr internally (bounded 4 KiB) without ever forwarding raw stderr to tasks, browsers, or logs.
    child.stderr.on('data', chunk => {
      if (errSnippet.length < 4096) errSnippet += chunk.toString('utf8').slice(0, 4096 - errSnippet.length);
    });
    child.on('close',code=>{
      closed=true;clearTimeout(killTimer);owner.children.delete(record);resolveExit();
      if (code === 0) { done(null, Buffer.concat(outChunks).toString('utf8')); return; }
      if (/unknown option|unrecognized option|invalid option/i.test(errSnippet)) {
        done(Object.assign(new Error('Claude Code CLI rejected an unsupported flag (unknown option).'), { code: 'UNSUPPORTED_CLI_FLAG', retryable: false }));
      } else if (/rate\s*limit|too many requests|429|overloaded|529|capacity|try again later/i.test(errSnippet)) {
        done(Object.assign(new Error('Claude Code CLI hit a temporary rate limit or capacity spike; retrying.'), { code: 'rate_limit', retryable: true }));
      } else if (/not logged in|unauthenticated|unauthorized|401|login|auth.*expired/i.test(errSnippet)) {
        done(Object.assign(new Error('Claude Code CLI authentication expired. Run `claude` to sign back in.'), { code: 'authentication', retryable: false }));
      } else {
        done(Object.assign(new Error('Claude Code CLI could not complete the request. Check CLI sign-in, model access and usage limits.'), { code: 'provider_configuration', retryable: false }));
      }
    });
    child.stdin.on('error',()=>{});
    if(signal?.aborted){abort();return;}
    child.stdin.end(input);
  });
}

export function environmentProviders() {
  const result=new Map();
  for(const profile of [
    {id:'openai',label:'OpenAI Responses',protocol:'openai-responses',baseUrl:'https://api.openai.com/v1',model:process.env.G0D_OPENAI_MODEL,apiKeyEnv:'OPENAI_API_KEY'},
    {id:'anthropic',label:'Anthropic Messages',protocol:'anthropic',baseUrl:'https://api.anthropic.com/v1',model:process.env.G0D_ANTHROPIC_MODEL,apiKeyEnv:'ANTHROPIC_API_KEY'},
    {id:'openrouter',label:'OpenRouter',protocol:'openai-chat',baseUrl:'https://openrouter.ai/api/v1',model:process.env.G0D_OPENROUTER_MODEL,apiKeyEnv:'OPENROUTER_API_KEY'},
    {id:'local',label:'User-configured endpoint',protocol:process.env.G0D_LOCAL_PROTOCOL||'openai-chat',baseUrl:process.env.G0D_LOCAL_URL,model:process.env.G0D_LOCAL_MODEL,apiKeyEnv:process.env.G0D_LOCAL_KEY_ENV,...(process.env.G0D_LOCAL_TIER?{tier:process.env.G0D_LOCAL_TIER.trim()}:{})}
  ]) {
    const prefix=`G0D_${profile.id.toUpperCase()}`,outputOptions={};
    for(const [suffix,field] of [['MAX_OUTPUT_TOKENS','maxOutputTokens'],['MAX_OUTPUT_TOKENS_CEILING','maxOutputTokensCeiling']]) {
      const name=`${prefix}_${suffix}`,value=process.env[name];
      if(value===undefined)continue;
      const text=value.trim();
      if(!/^[1-9]\d*$/.test(text)||Number(text)>200000)throw Object.assign(new Error(`${name} must be a decimal integer from 1 to 200000.`),{code:'provider_configuration',retryable:false});
      outputOptions[field]=Number(text);
    }
    if(profile.baseUrl&&profile.model) {
      const defaults = { timeoutMs: 600000, maxOutputTokens: 16000, maxOutputTokensCeiling: 64000 };
      if (outputOptions.maxOutputTokens !== undefined && outputOptions.maxOutputTokensCeiling === undefined) {
        defaults.maxOutputTokensCeiling = Math.max(defaults.maxOutputTokensCeiling, outputOptions.maxOutputTokens);
      }
      if (outputOptions.maxOutputTokensCeiling !== undefined && outputOptions.maxOutputTokens === undefined) {
        defaults.maxOutputTokens = Math.min(defaults.maxOutputTokens, outputOptions.maxOutputTokensCeiling);
      }
      try { result.set(profile.id,new HttpProvider({...defaults,...profile,...outputOptions})); }
      catch(error) {
        if(error.code==='provider_configuration')error.message=`${prefix}_MAX_OUTPUT_TOKENS / ${prefix}_MAX_OUTPUT_TOKENS_CEILING: ${error.message}`;
        throw error;
      }
    }
  }
  for(const model of (process.env.G0D_OPENROUTER_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean)) {
    const id=`openrouter:${model.replace(/\//g,'-')}`;
    try { result.set(id,new HttpProvider({id,label:`${model} · OpenRouter`,protocol:'openai-chat',baseUrl:'https://openrouter.ai/api/v1',model,apiKeyEnv:'OPENROUTER_API_KEY',timeoutMs:180000,maxOutputTokens:16000,maxOutputTokensCeiling:64000})); }
    catch(error) { if(error.code==='provider_configuration') throw error; }
  }
  for(const model of (process.env.G0D_VENICE_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean)) {
    const id=`venice:${model}`;
    try { result.set(id,new HttpProvider({id,label:`${model} · Venice`,protocol:'openai-chat',baseUrl:'https://api.venice.ai/api/v1',model,apiKeyEnv:'VENICE_API_KEY',timeoutMs:180000,maxOutputTokens:16000,maxOutputTokensCeiling:64000})); }
    catch(error) { if(error.code==='provider_configuration') throw error; }
  }
  for(const model of (process.env.G0D_GEMINI_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean)) {
    const id=`gemini:${model.replace(/[/:]/g,'-')}`;
    try { result.set(id,new HttpProvider({id,label:`${model} · Gemini API`,protocol:'openai-chat',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai',model,apiKeyEnv:'GEMINI_API_KEY',timeoutMs:180000,maxOutputTokens:16000,maxOutputTokensCeiling:64000})); }
    catch(error) { if(error.code==='provider_configuration') throw error; }
  }
  for(const model of (process.env.G0D_XAI_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean)) {
    const id=`xai:${model.replace(/[/:]/g,'-')}`;
    try { result.set(id,new HttpProvider({id,label:`${model} · xAI (Grok)`,protocol:'openai-chat',baseUrl:'https://api.x.ai/v1',model,apiKeyEnv:'XAI_API_KEY',timeoutMs:180000,maxOutputTokens:16000,maxOutputTokensCeiling:64000})); }
    catch(error) { if(error.code==='provider_configuration') throw error; }
  }
  for(const model of (process.env.G0D_META_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean)) {
    const id=`meta:${model.replace(/[/:]/g,'-')}`;
    try { result.set(id,new HttpProvider({id,label:`${model} · Meta AI`,protocol:'openai-chat',baseUrl:'https://api.llama.com/compat/v1',model,apiKeyEnv:'LLAMA_API_KEY',timeoutMs:180000,maxOutputTokens:16000,maxOutputTokensCeiling:64000})); }
    catch(error) { if(error.code==='provider_configuration') throw error; }
  }
  for(const model of (process.env.G0D_NOUS_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean)) {
    const id=`nous:${model.replace(/[/:]/g,'-')}`;
    try { result.set(id,new HttpProvider({id,label:`${model} · Nous Portal`,protocol:'openai-chat',baseUrl:'https://inference-api.nousresearch.com/v1',model,apiKeyEnv:'NOUS_API_KEY',timeoutMs:180000,maxOutputTokens:16000,maxOutputTokensCeiling:64000})); }
    catch(error) { if(error.code==='provider_configuration') throw error; }
  }
  const ollamaUrl=(process.env.G0D_OLLAMA_URL||'http://127.0.0.1:11434/v1').trim();
  for(const model of (process.env.G0D_OLLAMA_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean)) {
    const id=`ollama:${model.replace(/[/:]/g,'-')}`;
    try { result.set(id,new HttpProvider({id,label:`${model} · Ollama (Local)`,protocol:'openai-chat',baseUrl:ollamaUrl,model,apiKeyEnv:undefined,tier:'local',allowPrivateHttp:true,timeoutMs:180000,maxOutputTokens:8192,maxOutputTokensCeiling:32768})); }
    catch(error) { if(error.code==='provider_configuration') throw error; }
  }
  if(process.env.G0D_ENABLE_CODEX==='1')result.set('codex-cli',new CodexProvider({binary:process.env.G0D_CODEX_BINARY||'codex',model:process.env.G0D_CODEX_MODEL}));
  if(process.env.G0D_ENABLE_CODEX==='1')for(const model of (process.env.G0D_CODEX_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean)) {
    const id=`codex:${model}`;
    result.set(id,new CodexProvider({id,label:`${model} · Codex bridge`,binary:process.env.G0D_CODEX_BINARY||'codex',model}));
  }
  if(process.env.G0D_ENABLE_ANTIGRAVITY_CLI==='1')result.set('antigravity-cli',new AntigravityCliProvider({binary:process.env.G0D_ANTIGRAVITY_BINARY||'agy',model:process.env.G0D_ANTIGRAVITY_MODEL}));
  if(process.env.G0D_ENABLE_GEMINI_CLI==='1')result.set('gemini-cli',new GeminiCliProvider({binary:process.env.G0D_GEMINI_BINARY||'gemini',model:process.env.G0D_GEMINI_MODEL}));
  if(process.env.G0D_ENABLE_COPILOT_CLI==='1')result.set('copilot-cli',new CopilotCliProvider({binary:process.env.G0D_COPILOT_BINARY||'copilot',model:process.env.G0D_COPILOT_MODEL}));
  return result;
}
import { parametersFor, parameterLimits } from './conversation-controls.mjs';
