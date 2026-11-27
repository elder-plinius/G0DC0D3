import { promises as fs, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { checkProviderPrivacyAllowed, DEFAULT_PRIVACY_SETTINGS } from './privacy.mjs';

/**
 * G0DC0D3 Estimated Model Catalog & Live OpenRouter Pricing.
 *
 * - Offline-first: ships a structured baseline catalog with transparent coding & reasoning
 *   capability heuristics, indicative API pricing ($/1M tokens), context windows, and speed bands.
 *   Bundled values are estimates, not measured benchmarks or provider quotes.
 * - Privacy-safe live pricing sync: explicit user-triggered refresh fetches OpenRouter's public
 *   zero-auth model metadata endpoint (`https://openrouter.ai/api/v1/models`), respects Local-Only
 *   Airgap Mode, logs to OutboundAuditLog, and caches locally with 0o600 permissions.
 * - Zero telemetry: never calls out on startup and never transmits usage or identity data.
 */

export const CATALOG_VERSION = '2026-11';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export const MODEL_CATALOG = Object.freeze([
  // ── Frontier Tier S (93–100) ───────────────────────────────────────────
  {
    id: 'claude-opus-5-5',
    match: /claude[-_.]?(?:opus[-_.]?5(?:[-_.]?5)?|5(?:[-_.]?5)?[-_.]?opus|fable[-_.]?5)/i,
    family: 'Claude 5 Opus',
    coding: 100, reasoning: 100, size: 'frontier', speed: 'balanced', tokPerSec: 70,
    contextWindow: 256000, maxOutput: 128000,
    pricing: { inputPer1M: 15, outputPer1M: 75, cachedInputPer1M: 1.5 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'reasoning']
  },
  {
    id: 'openai-gpt-6-astra',
    match: /(?:openai[-_.]?)?gpt[-_.]?6(?:[._-]?[12])?[-_.]?(?:astra|sol|luna|terra)/i,
    family: 'GPT-6 Astra / Sol',
    coding: 100, reasoning: 99, size: 'frontier', speed: 'balanced', tokPerSec: 80,
    contextWindow: 400000, maxOutput: 128000,
    pricing: { inputPer1M: 4, outputPer1M: 20, cachedInputPer1M: 0.4 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'reasoning']
  },
  {
    id: 'gemini-4',
    match: /gemini[-_.]?4[-_.]?(?:carbon|argon|neon|hydrogen|pro)/i,
    family: 'Gemini 4',
    coding: 98, reasoning: 98, size: 'frontier', speed: 'fast', tokPerSec: 95,
    contextWindow: 1000000, maxOutput: 65536,
    pricing: { inputPer1M: 2, outputPer1M: 12, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'reasoning']
  },
  {
    id: 'deepseek-v4',
    match: /deepseek[-_.]?v4/i,
    family: 'DeepSeek V4',
    coding: 96, reasoning: 96, size: 'frontier', speed: 'fast', tokPerSec: 95,
    contextWindow: 262144, maxOutput: 131072,
    pricing: { inputPer1M: 0.35, outputPer1M: 1.4, cachedInputPer1M: 0.08 },
    capabilities: { tools: true, reasoning: true, vision: false, openWeight: true },
    tags: ['flagship', 'open-weight', 'coding', 'reasoning']
  },
  {
    id: 'kimi-k3',
    match: /kimi[-_.]?k3/i,
    family: 'Kimi K3',
    coding: 95, reasoning: 95, size: 'frontier', speed: 'fast', tokPerSec: 90,
    contextWindow: 262144, maxOutput: 131072,
    pricing: { inputPer1M: 0.5, outputPer1M: 2.0, cachedInputPer1M: 0.1 },
    capabilities: { tools: true, reasoning: true, vision: false, openWeight: true },
    tags: ['flagship', 'open-weight', 'coding', 'reasoning']
  },
  {
    id: 'qwen-4-max',
    match: /qwen[-_.]?(?:4[-_.]?max|3[-_.]?8[-_.]?(?:max|2[-_.]?4t))/i,
    family: 'Qwen 4 Max',
    coding: 95, reasoning: 95, size: 'frontier', speed: 'balanced', tokPerSec: 75,
    contextWindow: 262144, maxOutput: 131072,
    pricing: { inputPer1M: 0.4, outputPer1M: 1.6, cachedInputPer1M: 0.1 },
    capabilities: { tools: true, reasoning: true, vision: false, openWeight: true },
    tags: ['flagship', 'open-weight', 'coding', 'reasoning']
  },
  {
    id: 'claude-opus-4-6',
    match: /claude[-_.]?(?:opus[-_.]?4[-_.]?[5678]|4[-_.]?[5678][-_.]?opus|opus[-_.]?4\b)/i,
    family: 'Claude 4 Opus',
    coding: 99, reasoning: 98, size: 'frontier', speed: 'balanced', tokPerSec: 65,
    contextWindow: 200000, maxOutput: 64000,
    pricing: { inputPer1M: 15, outputPer1M: 75, cachedInputPer1M: 1.5 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'reasoning']
  },
  {
    id: 'claude-sonnet-5-5',
    match: /claude[-_.]?(?:sonnet[-_.]?5(?:[-_.]?5)?|5(?:[-_.]?5)?[-_.]?sonnet)/i,
    family: 'Claude 5 Sonnet',
    coding: 98, reasoning: 96, size: 'frontier', speed: 'fast', tokPerSec: 95,
    contextWindow: 256000, maxOutput: 64000,
    pricing: { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'fast']
  },
  {
    id: 'gpt-5.4',
    match: /\bgpt[-_.]?5(?:\.[3456])?(?:[-_.]?(?:pro|sol|terra|luna))?\b(?!.*(?:mini|nano|codex))/i,
    family: 'GPT-5',
    coding: 98, reasoning: 98, size: 'frontier', speed: 'balanced', tokPerSec: 75,
    contextWindow: 400000, maxOutput: 128000,
    pricing: { inputPer1M: 2.5, outputPer1M: 15, cachedInputPer1M: 0.25 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'reasoning']
  },
  {
    id: 'gpt-5.3-codex',
    match: /gpt[-_.]?5(?:\.3|\.2)?[-_.]?codex|\bcodex[-_.]?1\b/i,
    family: 'GPT-5 Codex',
    coding: 98, reasoning: 95, size: 'frontier', speed: 'balanced', tokPerSec: 80,
    contextWindow: 400000, maxOutput: 128000,
    pricing: { inputPer1M: 2, outputPer1M: 12, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'reasoning']
  },
  {
    id: 'gemini-3-pro',
    match: /gemini[-_.]?3(?:\.0)?[-_.]?pro/i,
    family: 'Gemini 3 Pro',
    coding: 97, reasoning: 97, size: 'frontier', speed: 'balanced', tokPerSec: 85,
    contextWindow: 1000000, maxOutput: 65536,
    pricing: { inputPer1M: 2, outputPer1M: 12, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'reasoning']
  },
  {
    id: 'claude-sonnet-4-6',
    match: /claude[-_.]?(?:sonnet[-_.]?4[-_.]?6|4[-_.]?6[-_.]?sonnet|sonnet[-_.]?4[-_.]?5|4[-_.]?5[-_.]?sonnet|sonnet[-_.]?4\b|3[-_.]?7[-_.]?sonnet)/i,
    family: 'Claude 4 Sonnet',
    coding: 97, reasoning: 94, size: 'large', speed: 'fast', tokPerSec: 95,
    contextWindow: 200000, maxOutput: 64000,
    pricing: { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'fast']
  },
  {
    id: 'o3',
    match: /\bo3(?:-pro)?\b(?!-mini)|\bo4\b(?!-mini)/i,
    family: 'OpenAI o3',
    coding: 95, reasoning: 98, size: 'frontier', speed: 'reasoning', tokPerSec: 55,
    contextWindow: 200000, maxOutput: 100000,
    pricing: { inputPer1M: 2, outputPer1M: 8, cachedInputPer1M: 0.5 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'reasoning', 'coding']
  },
  {
    id: 'gemini-2.5-pro',
    match: /gemini[-_.]?2\.5[-_.]?pro/i,
    family: 'Gemini 2.5 Pro',
    coding: 94, reasoning: 95, size: 'frontier', speed: 'balanced', tokPerSec: 80,
    contextWindow: 1000000, maxOutput: 65536,
    pricing: { inputPer1M: 1.25, outputPer1M: 10, cachedInputPer1M: 0.31 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'reasoning']
  },
  {
    id: 'grok-4',
    match: /grok[-_.]?(?:4|code)/i,
    family: 'Grok 4',
    coding: 95, reasoning: 96, size: 'frontier', speed: 'balanced', tokPerSec: 85,
    contextWindow: 256000, maxOutput: 64000,
    pricing: { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.75 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'reasoning']
  },
  {
    id: 'muse-spark',
    match: /muse[-_.]?spark/i,
    family: 'Meta Muse Spark',
    coding: 95, reasoning: 95, size: 'frontier', speed: 'fast', tokPerSec: 95,
    contextWindow: 256000, maxOutput: 64000,
    pricing: { inputPer1M: 0.8, outputPer1M: 3.2, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['flagship', 'coding', 'reasoning', 'fast']
  },
  {
    id: 'deepseek-r1',
    match: /deepseek[-_.]?r1/i,
    family: 'DeepSeek R1',
    coding: 93, reasoning: 95, size: 'frontier', speed: 'reasoning', tokPerSec: 55,
    contextWindow: 128000, maxOutput: 32768,
    pricing: { inputPer1M: 0.55, outputPer1M: 2.19, cachedInputPer1M: 0.14 },
    capabilities: { tools: true, reasoning: true, vision: false, openWeight: true },
    tags: ['flagship', 'open-weight', 'reasoning', 'coding']
  },
  {
    id: 'qwen3-coder-480b',
    match: /qwen[-_.]?3[-_.]?coder[-_.]?480b/i,
    family: 'Qwen3 Coder 480B',
    coding: 94, reasoning: 90, size: 'frontier', speed: 'balanced', tokPerSec: 70,
    contextWindow: 262144, maxOutput: 65536,
    pricing: { inputPer1M: 0.4, outputPer1M: 1.6, cachedInputPer1M: 0.1 },
    capabilities: { tools: true, reasoning: true, vision: false, openWeight: true },
    tags: ['flagship', 'open-weight', 'coding']
  },
  {
    id: 'hermes-4-405b',
    match: /hermes[-_.]?4[-_.]?405b/i,
    family: 'Hermes 4 405B',
    coding: 92, reasoning: 94, size: 'frontier', speed: 'balanced', tokPerSec: 65,
    contextWindow: 131072, maxOutput: 32768,
    pricing: { inputPer1M: 1.0, outputPer1M: 3.0, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: true, vision: false, openWeight: true },
    tags: ['flagship', 'open-weight', 'reasoning']
  },

  // ── High-Capability Tier A (85–92) ─────────────────────────────────────
  {
    id: 'qwen3-235b',
    match: /qwen[-_.]?3[-_.]?235b/i,
    family: 'Qwen3 235B',
    coding: 92, reasoning: 92, size: 'frontier', speed: 'balanced', tokPerSec: 75,
    contextWindow: 131072, maxOutput: 32768,
    pricing: { inputPer1M: 0.25, outputPer1M: 0.9, cachedInputPer1M: 0.06 },
    capabilities: { tools: true, reasoning: true, vision: false, openWeight: true },
    tags: ['flagship', 'open-weight', 'coding', 'reasoning']
  },
  {
    id: 'kimi-k2',
    match: /kimi[-_.]?k2/i,
    family: 'Kimi K2',
    coding: 92, reasoning: 90, size: 'frontier', speed: 'fast', tokPerSec: 90,
    contextWindow: 131072, maxOutput: 32768,
    pricing: { inputPer1M: 0.4, outputPer1M: 1.6, cachedInputPer1M: 0.1 },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['flagship', 'coding', 'open-weight', 'fast']
  },
  {
    id: 'deepseek-v3',
    match: /deepseek[-_.]?(?:chat|v3)/i,
    family: 'DeepSeek V3',
    coding: 91, reasoning: 89, size: 'large', speed: 'fast', tokPerSec: 90,
    contextWindow: 128000, maxOutput: 16384,
    pricing: { inputPer1M: 0.27, outputPer1M: 1.1, cachedInputPer1M: 0.07 },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['coding', 'open-weight', 'fast']
  },
  {
    id: 'llama-4-maverick',
    match: /llama[-_.]?4[-_.]?(?:maverick|behemoth)/i,
    family: 'Llama 4 Maverick',
    coding: 89, reasoning: 89, size: 'large', speed: 'fast', tokPerSec: 110,
    contextWindow: 1000000, maxOutput: 32768,
    pricing: { inputPer1M: 0.2, outputPer1M: 0.6, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: true, openWeight: true },
    tags: ['flagship', 'open-weight', 'fast']
  },
  {
    id: 'glm-5',
    match: /glm[-_.]?(?:4\.5|5)/i,
    family: 'GLM-4.5 / 5',
    coding: 89, reasoning: 88, size: 'large', speed: 'fast', tokPerSec: 95,
    contextWindow: 128000, maxOutput: 32768,
    pricing: { inputPer1M: 0.35, outputPer1M: 1.4, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: true, vision: false, openWeight: true },
    tags: ['coding', 'open-weight', 'fast']
  },
  {
    id: 'hermes-4-70b',
    match: /hermes[-_.]?4[-_.]?70b|hermes[-_.]?3[-_.]?405b/i,
    family: 'Hermes 4 70B',
    coding: 87, reasoning: 88, size: 'large', speed: 'balanced', tokPerSec: 80,
    contextWindow: 131072, maxOutput: 32768,
    pricing: { inputPer1M: 0.4, outputPer1M: 1.2, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: true, vision: false, openWeight: true },
    tags: ['open-weight']
  },
  {
    id: 'gpt-4.1',
    match: /gpt[-_.]?4\.1\b/i,
    family: 'GPT-4.1',
    coding: 89, reasoning: 86, size: 'large', speed: 'fast', tokPerSec: 100,
    contextWindow: 1000000, maxOutput: 32768,
    pricing: { inputPer1M: 2.0, outputPer1M: 8.0, cachedInputPer1M: 0.5 },
    capabilities: { tools: true, reasoning: false, vision: true, openWeight: false },
    tags: ['coding', 'fast']
  },
  {
    id: 'qwen-coder-large',
    match: /qwen(?:2\.5|3)[-_.]?coder[-_:]?(?:72b|32b)\b/i,
    family: 'Qwen Coder 32B/72B',
    coding: 88, reasoning: 82, size: 'large', speed: 'fast', tokPerSec: 85,
    contextWindow: 131072, maxOutput: 16384,
    pricing: { inputPer1M: 0.12, outputPer1M: 0.36, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['coding', 'open-weight', 'fast']
  },
  {
    id: 'gemini-flash',
    match: /gemini[-_.]?(?:2\.5|3)[-_.]?flash/i,
    family: 'Gemini Flash',
    coding: 86, reasoning: 85, size: 'medium', speed: 'fast', tokPerSec: 180,
    contextWindow: 1000000, maxOutput: 65536,
    pricing: { inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.04 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['fast', 'coding']
  },
  {
    id: 'o4-mini',
    match: /o3[-_.]?mini|o4[-_.]?mini|gpt[-_.]?5[-_.]?mini/i,
    family: 'OpenAI Mini Reasoning',
    coding: 87, reasoning: 89, size: 'medium', speed: 'fast', tokPerSec: 130,
    contextWindow: 200000, maxOutput: 100000,
    pricing: { inputPer1M: 0.55, outputPer1M: 2.2, cachedInputPer1M: 0.14 },
    capabilities: { tools: true, reasoning: true, vision: true, openWeight: false },
    tags: ['fast', 'coding', 'reasoning']
  },
  {
    id: 'claude-haiku',
    match: /claude[-_.]?(?:haiku[-_.]?4[-_.]?5|4[-_.]?5[-_.]?haiku|haiku)/i,
    family: 'Claude Haiku',
    coding: 85, reasoning: 82, size: 'medium', speed: 'fast', tokPerSec: 160,
    contextWindow: 200000, maxOutput: 64000,
    pricing: { inputPer1M: 0.8, outputPer1M: 4.0, cachedInputPer1M: 0.08 },
    capabilities: { tools: true, reasoning: false, vision: true, openWeight: false },
    tags: ['fast', 'coding']
  },
  {
    id: 'gpt-4o',
    match: /gpt[-_.]?4o\b/i,
    family: 'GPT-4o',
    coding: 85, reasoning: 84, size: 'large', speed: 'fast', tokPerSec: 105,
    contextWindow: 128000, maxOutput: 16384,
    pricing: { inputPer1M: 2.5, outputPer1M: 10.0, cachedInputPer1M: 1.25 },
    capabilities: { tools: true, reasoning: false, vision: true, openWeight: false },
    tags: ['coding', 'fast']
  },
  {
    id: 'venice-uncensored',
    match: /venice[-_.]?uncensored/i,
    family: 'Venice Uncensored',
    coding: 84, reasoning: 84, size: 'large', speed: 'fast', tokPerSec: 95,
    contextWindow: 65536, maxOutput: 16384,
    pricing: { inputPer1M: 0.5, outputPer1M: 2.0, cachedInputPer1M: null },
    capabilities: { tools: false, reasoning: false, vision: false, openWeight: true },
    tags: ['open-weight', 'fast', 'zdr-native']
  },
  {
    id: 'llama-4-scout',
    match: /llama[-_.]?4[-_.]?scout/i,
    family: 'Llama 4 Scout',
    coding: 84, reasoning: 83, size: 'medium', speed: 'fast', tokPerSec: 150,
    contextWindow: 512000, maxOutput: 32768,
    pricing: { inputPer1M: 0.1, outputPer1M: 0.3, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: true, openWeight: true },
    tags: ['open-weight', 'fast']
  },
  {
    id: 'mistral-coding',
    match: /mistral[-_.]?large|codestral|devstral/i,
    family: 'Mistral / Devstral',
    coding: 86, reasoning: 82, size: 'large', speed: 'fast', tokPerSec: 105,
    contextWindow: 128000, maxOutput: 32768,
    pricing: { inputPer1M: 0.3, outputPer1M: 0.9, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['coding', 'open-weight', 'fast']
  },
  {
    id: 'glm-4',
    match: /glm[-_.]?4/i,
    family: 'GLM-4',
    coding: 84, reasoning: 83, size: 'large', speed: 'fast', tokPerSec: 95,
    contextWindow: 128000, maxOutput: 16384,
    pricing: { inputPer1M: 0.25, outputPer1M: 0.9, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['open-weight', 'fast']
  },

  // ── Mid / Compact Coder & Local Parameter Tiers (Tier B/C) ─────────────
  {
    id: 'qwen-coder-medium',
    match: /qwen(?:2\.5|3)[-_.]?coder[-_:]?(?:24b|16b|14b)\b/i,
    family: 'Qwen Coder 14B/24B',
    coding: 81, reasoning: 76, size: 'medium', speed: 'fast', tokPerSec: 110,
    contextWindow: 65536, maxOutput: 16384,
    pricing: { inputPer1M: 0.08, outputPer1M: 0.24, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['coding', 'open-weight', 'fast']
  },
  {
    id: 'qwen-coder-compact',
    match: /qwen(?:2\.5|3)[-_.]?coder[-_:]?(?:8b|7b|3b|1\.5b)\b/i,
    family: 'Qwen Coder Compact',
    coding: 73, reasoning: 68, size: 'compact', speed: 'fast', tokPerSec: 150,
    contextWindow: 32768, maxOutput: 8192,
    pricing: { inputPer1M: 0.04, outputPer1M: 0.12, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['coding', 'open-weight', 'fast']
  },
  {
    id: 'qwen-coder-generic',
    match: /qwen(?:2\.5|3)[-_.]?coder/i,
    family: 'Qwen Coder',
    coding: 84, reasoning: 79, size: 'large', speed: 'fast', tokPerSec: 95,
    contextWindow: 131072, maxOutput: 16384,
    pricing: { inputPer1M: 0.1, outputPer1M: 0.3, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['coding', 'open-weight', 'fast']
  },
  {
    id: 'local-70b',
    match: /(?<![a-z0-9])(?:70b|72b|120b|123b)(?![a-z0-9])/i,
    family: 'Open-Weight 70B+',
    coding: 84, reasoning: 84, size: 'large', speed: 'balanced', tokPerSec: 45,
    contextWindow: 128000, maxOutput: 16384,
    pricing: { inputPer1M: 0.25, outputPer1M: 0.75, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['open-weight']
  },
  {
    id: 'local-32b',
    match: /(?<![a-z0-9])(?:27b|30b|32b|34b)(?![a-z0-9])/i,
    family: 'Open-Weight 32B',
    coding: 80, reasoning: 78, size: 'medium', speed: 'balanced', tokPerSec: 75,
    contextWindow: 65536, maxOutput: 16384,
    pricing: { inputPer1M: 0.12, outputPer1M: 0.36, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['open-weight', 'coding']
  },
  {
    id: 'local-14b',
    match: /(?<![a-z0-9])(?:12b|14b|16b|20b|24b)(?![a-z0-9])/i,
    family: 'Open-Weight 14B',
    coding: 75, reasoning: 73, size: 'medium', speed: 'fast', tokPerSec: 110,
    contextWindow: 32768, maxOutput: 8192,
    pricing: { inputPer1M: 0.08, outputPer1M: 0.24, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['open-weight', 'fast']
  },
  {
    id: 'local-7b',
    match: /(?<![a-z0-9])(?:3b|4b|7b|8b|9b)(?![a-z0-9])/i,
    family: 'Open-Weight Compact',
    coding: 67, reasoning: 65, size: 'compact', speed: 'fast', tokPerSec: 160,
    contextWindow: 32768, maxOutput: 8192,
    pricing: { inputPer1M: 0.04, outputPer1M: 0.12, cachedInputPer1M: null },
    capabilities: { tools: true, reasoning: false, vision: false, openWeight: true },
    tags: ['open-weight', 'fast']
  }
]);

export function extractParamBillions(text) {
  let max = 0;
  for (const m of String(text || '').matchAll(/(?<![a-z0-9])(\d+(?:\.\d+)?)b(?![a-z0-9])/gi)) {
    const val = Number(m[1]);
    if (Number.isFinite(val) && val > max) max = val;
  }
  return max;
}

export function capabilityTier(score) {
  if (score >= 93) return 'S';
  if (score >= 85) return 'A';
  if (score >= 76) return 'B';
  return 'C';
}

export function formatContextWindow(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export function formatPricePer1M(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return '$0';
  if (n < 0.1) return `$${n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  if (n < 1) return `$${n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${Number(n.toFixed(2))}`;
}

export function computeBlendedPrice(pricing) {
  if (!pricing || typeof pricing !== 'object') return null;
  if (pricing.inputPer1M == null || pricing.outputPer1M == null || pricing.inputPer1M === '' || pricing.outputPer1M === '') return null;
  const inp = Number(pricing.inputPer1M);
  const out = Number(pricing.outputPer1M);
  if (!Number.isFinite(inp) || !Number.isFinite(out) || inp < 0 || out < 0) return null;
  // Standard coding workload blend: 75% input tokens, 25% output tokens
  return Number(((inp * 3 + out) / 4).toFixed(4));
}

export function computeValueScore({ intelligence, billing, blendedPricePer1M }) {
  if (billing === 'local') return Number((intelligence * 1.15).toFixed(1));
  if (billing === 'subscription') return Number((intelligence * 1.18).toFixed(1));
  if (!Number.isFinite(blendedPricePer1M) || blendedPricePer1M <= 0) return intelligence;
  // Log-scaled cost-efficiency: rewards high capability at low $/1M without letting weak ultra-cheap models outrank S-tier value leaders
  const score = intelligence / Math.pow(1 + blendedPricePer1M, 0.28);
  return Number(score.toFixed(1));
}

function normalizeModelSlug(value) {
  return String(value || '').trim().toLowerCase().replace(/^[^:]+:/, '');
}

export function findLiveEntry(liveMap, provider) {
  if (!liveMap || !liveMap.size) return null;
  const candidates = [
    provider?.model,
    normalizeModelSlug(provider?.model),
    normalizeModelSlug(provider?.id)
  ].filter(Boolean);
  for (const key of candidates) {
    const exact = liveMap.get(key.toLowerCase());
    if (exact) return exact;
    const stripped = key.toLowerCase().split('/').pop();
    if (stripped && liveMap.has(stripped)) return liveMap.get(stripped);
  }
  return null;
}

export function resolveCatalogEntry(provider, liveMap = null) {
  const haystack = `${provider?.id || ''} ${provider?.model || ''} ${provider?.label || ''}`;
  const paramB = extractParamBillions(haystack);
  let matched = null;
  for (const entry of MODEL_CATALOG) {
    if (entry.match.test(haystack)) {
      matched = entry;
      break;
    }
  }

  let coding = matched?.coding ?? (provider?.tier === 'frontier' ? 91 : provider?.tier === 'local' ? 75 : 80);
  let reasoning = matched?.reasoning ?? (provider?.tier === 'frontier' ? 90 : provider?.tier === 'local' ? 73 : 78);
  let size = matched?.size ?? (provider?.tier === 'frontier' ? 'frontier' : provider?.tier === 'local' ? 'medium' : 'large');
  let speed = matched?.speed ?? (provider?.tier === 'local' ? 'fast' : 'balanced');
  let tokPerSec = matched?.tokPerSec ?? (speed === 'fast' ? 110 : speed === 'reasoning' ? 55 : 75);
  let contextWindow = matched?.contextWindow ?? 128000;
  let maxOutput = matched?.maxOutput ?? 16384;
  let pricing = matched?.pricing ? { ...matched.pricing } : null;
  let pricingSource = matched ? 'bundled-estimate' : 'unknown';
  const capabilities = matched?.capabilities ? { ...matched.capabilities } : { tools: true, reasoning: false, vision: false, openWeight: provider?.tier === 'local' };
  const tags = new Set(matched?.tags || []);

  // CLI subscription bridges default to frontier coding capability if no explicit model matched
  const isSubscription = ['claude', 'codex', 'antigravity-cli', 'gemini-cli', 'copilot-cli'].includes(provider?.kind);
  if (isSubscription) {
    tags.add('coding');
    if (!matched) {
      coding = provider.kind === 'claude' ? 97 : provider.kind === 'codex' ? 97 : 93;
      reasoning = provider.kind === 'claude' ? 95 : provider.kind === 'codex' ? 95 : 92;
      size = 'frontier';
      tags.add('flagship');
    }
  }

  // OpenRouter quotes apply only to an OpenRouter route, not the same model
  // on Venice, another vendor, a subscription, or a local runtime.
  let isOpenRouter = false;
  try { isOpenRouter = new URL(provider?.baseUrl).hostname === 'openrouter.ai'; } catch {}
  const live = isOpenRouter ? findLiveEntry(liveMap, provider) : null;
  if (live) {
    if (Number.isFinite(live.contextWindow) && live.contextWindow > 0) contextWindow = live.contextWindow;
    if (Number.isFinite(live.maxOutput) && live.maxOutput > 0) maxOutput = live.maxOutput;
    if (live.pricing && Number.isFinite(live.pricing.inputPer1M) && Number.isFinite(live.pricing.outputPer1M)) {
      pricing = { ...pricing, ...live.pricing };
      pricingSource = 'openrouter-live';
    }
  }

  const intelligence = Math.round(coding * 0.65 + reasoning * 0.35);
  return {
    family: matched?.family || provider?.model || provider?.label || provider?.id || 'Model',
    coding,
    reasoning,
    intelligence,
    tier: capabilityTier(intelligence),
    size,
    paramB,
    speed,
    tokPerSec,
    contextWindow,
    contextLabel: formatContextWindow(contextWindow),
    maxOutput,
    pricing,
    pricingSource,
    rankingSource: 'heuristic',
    capabilities,
    tags
  };
}

export async function createModelCatalog({ dataDir, fetchImpl = globalThis.fetch } = {}) {
  const filename = dataDir ? path.join(path.resolve(dataDir), 'model-catalog-cache.json') : null;
  let liveMap = new Map();
  let liveEntries = [];
  let updatedAt = null;
  let liveCount = 0;
  let expiresAt = 0;
  let pendingRefresh = null;

  const hydrate = entries => {
    const next = new Map();
    const cleaned = [];
    const seen = new Set();
    for (const item of entries || []) {
      if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/+~-]{0,159}$/.test(item.id)) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      cleaned.push(item);
      const lower = item.id.toLowerCase();
      next.set(lower, item);
      const short = lower.split('/').pop();
      if (short && !next.has(short)) next.set(short, item);
    }
    liveMap = next;
    liveEntries = cleaned;
    liveCount = cleaned.length;
  };

  if (filename) {
    try {
      const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (stat.isFile() && stat.size <= 4 * 1024 * 1024) {
          const parsed = JSON.parse(await handle.readFile('utf8'));
          if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
            hydrate(parsed.entries);
            updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
          }
        }
      } finally {
        await handle.close();
      }
    } catch {}
  }

  async function save(entries, timestamp) {
    if (!filename) return;
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const tmp = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ version: 1, updatedAt: timestamp, entries }) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, filename);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async function doRefresh({ privacy = DEFAULT_PRIVACY_SETTINGS, onOutbound } = {}) {
    const gate = checkProviderPrivacyAllowed({ id: 'openrouter:catalog', label: 'OpenRouter Model Catalog', baseUrl: OPENROUTER_MODELS_URL }, privacy);
    if (!gate.allowed) {
      onOutbound?.({
        providerId: 'catalog:openrouter',
        host: 'openrouter.ai',
        protocol: 'catalog-sync',
        zdrClass: gate.posture.zdrClass,
        zdrFlags: [],
        secretsRedacted: 0,
        blocked: true,
        reason: gate.message
      });
      throw Object.assign(new Error(gate.message), { code: gate.code, status: 403 });
    }
    if (typeof fetchImpl !== 'function') {
      throw Object.assign(new Error('Fetch API unavailable for catalog refresh.'), { code: 'CATALOG_UNAVAILABLE', status: 503 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      onOutbound?.({
        providerId: 'catalog:openrouter',
        host: 'openrouter.ai',
        protocol: 'catalog-sync',
        zdrClass: 'provider-policy',
        zdrFlags: ['public-readonly-catalog', 'zero-auth'],
        secretsRedacted: 0,
        blocked: false,
        reason: null
      });
      const response = await fetchImpl(OPENROUTER_MODELS_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal
      });
      if (!response.ok) {
        throw Object.assign(new Error(`OpenRouter catalog returned HTTP ${response.status}.`), { code: 'CATALOG_HTTP_ERROR', status: 502 });
      }
      const payload = await response.json();
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const entries = [];
      for (const row of rows) {
        if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/+~-]{0,159}$/.test(row.id)) continue;
        // Skip models whose output modality explicitly excludes text (e.g. pure embedding/image-only).
        const outMods = Array.isArray(row.architecture?.output_modalities) ? row.architecture.output_modalities : null;
        if (outMods && outMods.length && !outMods.includes('text')) continue;
        const price = value => value == null || value === '' ? NaN : Number(value);
        const pIn = price(row.pricing?.prompt);
        const pOut = price(row.pricing?.completion);
        const inputPer1M = Number.isFinite(pIn) && pIn >= 0 ? Number((pIn * 1e6).toFixed(4)) : null;
        const outputPer1M = Number.isFinite(pOut) && pOut >= 0 ? Number((pOut * 1e6).toFixed(4)) : null;
        const contextWindow = Number(row.context_length ?? row.contextLength ?? 0) || null;
        const maxOutput = Number(row.top_provider?.max_completion_tokens ?? row.topProvider?.maxCompletionTokens ?? 0) || null;
        const params = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
        const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 160) : null;
        entries.push({
          id: row.id,
          ...(name ? { name } : {}),
          contextWindow,
          maxOutput,
          pricing: inputPer1M !== null && outputPer1M !== null ? { inputPer1M, outputPer1M } : null,
          ...(params.includes('tools') ? { supportsTools: true } : {}),
          ...(params.includes('reasoning') || params.includes('include_reasoning') ? { supportsReasoning: true } : {}),
        });
      }
      const now = new Date().toISOString();
      hydrate(entries);
      updatedAt = now;
      expiresAt = Date.now() + 15 * 60000;
      await save(entries, now);
      return { ok: true, count: entries.length, updatedAt: now, source: 'openrouter-live' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get liveMap() { return liveMap; },
    listEntries() { return liveEntries.slice(); },
    meta() {
      return {
        catalogVersion: CATALOG_VERSION,
        bundledCount: MODEL_CATALOG.length,
        liveCount,
        updatedAt,
        source: liveCount > 0 ? 'openrouter-live+bundled' : 'bundled-offline'
      };
    },
    lookup(provider) {
      return resolveCatalogEntry(provider, liveMap);
    },
    refresh(opts = {}) {
      return doRefresh(opts);
    },
    async ensureFresh({ privacy = DEFAULT_PRIVACY_SETTINGS, onOutbound, force = false } = {}) {
      if (privacy?.localOnly) {
        return {
          entries: liveEntries.slice(),
          updatedAt,
          stale: true,
          warning: 'Local-only inference is enabled. OpenRouter catalog refresh is paused.'
        };
      }
      if (force || !liveEntries.length || Date.now() >= expiresAt) {
        try {
          pendingRefresh ??= doRefresh({ privacy, onOutbound }).finally(() => { pendingRefresh = null; });
          await pendingRefresh;
          return { entries: liveEntries.slice(), updatedAt, stale: false, warning: '' };
        } catch (error) {
          expiresAt = Date.now() + 30000;
          return {
            entries: liveEntries.slice(),
            updatedAt,
            stale: true,
            warning: liveEntries.length
              ? 'OpenRouter catalog is temporarily unreachable. Showing cached models.'
              : (error?.message || 'Could not load the OpenRouter catalog. Refresh to try again.')
          };
        }
      }
      return { entries: liveEntries.slice(), updatedAt, stale: false, warning: '' };
    },
  };
}
