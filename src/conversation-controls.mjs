const fault = (code, message) => Object.assign(new Error(message), { code });
export const parameterBounds = { temperature: [0, 2], top_p: [0, 1], max_tokens: [1, 200000], frequency_penalty: [-2, 2], presence_penalty: [-2, 2], seed: [0, 2147483647], top_k: [0, 1000], min_p: [0, 1] };

export function parameterLimits(provider) {
  const metadata = provider?.modelMetadata;
  const fields = {};
  for (const [key, [minimum, maximum]] of Object.entries(parameterBounds)) {
    const appRange = ['max_tokens','seed','top_k'].includes(key);
    const field = { min:minimum, max:maximum, minSource:appRange ? 'app' : 'api', maxSource:appRange ? 'app' : 'api', supported:provider?.protocol === 'openai-chat' };
    if (['top_k','min_p'].includes(key) && provider?.baseUrl !== 'https://api.venice.ai/api/v1') field.supported = false;
    const constraint = metadata?.constraints?.[key];
    if (constraint && (!Number.isFinite(constraint.min) || !Number.isFinite(constraint.max) || constraint.min <= constraint.max)) {
      if (Number.isFinite(constraint.min) && constraint.min >= minimum && constraint.min <= maximum) { field.min = constraint.min; field.minSource = 'model'; }
      if (Number.isFinite(constraint.max) && constraint.max <= maximum && constraint.max >= field.min) { field.max = constraint.max; field.maxSource = 'model'; }
      if (Number.isFinite(constraint.default) && constraint.default >= field.min && constraint.default <= field.max) { field.default = constraint.default; field.defaultSource = 'model'; }
    }
    // Live Venice checks (2026-11-24): GLM rejects seed 0 with HTTP 400,
    // while the identical request with seed 1 succeeds. The catalog omits
    // this bound; prefer any future published constraint over this fallback.
    if (key === 'seed' && provider?.baseUrl === 'https://api.venice.ai/api/v1'
      && provider?.model === 'z-ai-glm-5-3-flash' && !Number.isFinite(constraint?.min)) {
      field.min = 1; field.minSource = 'verified';
    }
    if (key === 'max_tokens') {
      if (Number.isInteger(metadata?.maxCompletionTokens) && metadata.maxCompletionTokens > 0) { field.max = Math.min(maximum, metadata.maxCompletionTokens); field.maxSource = metadata.maxCompletionTokens <= maximum ? 'model' : 'app'; }
      if (Number.isInteger(provider?.maxOutputTokensCeiling) && provider.maxOutputTokensCeiling < field.max) { field.max = provider.maxOutputTokensCeiling; field.maxSource = 'connection'; }
      if (Number.isInteger(provider?.maxOutputTokens)) { field.default = Math.min(provider.maxOutputTokens,field.max); field.defaultSource = 'app'; }
    }
    fields[key] = field;
  }
  return { id:provider?.id, label:provider?.label || provider?.model || provider?.id, fields, metadataAt:metadata?.fetchedAt || null };
}

export function intersectParameterLimits(models) {
  const fields = {};
  for (const key of Object.keys(parameterBounds)) {
    const limits = models.map(model => model.fields[key]);
    const lower = limits.reduce((a,b) => b.min > a.min ? b : a);
    const upper = limits.reduce((a,b) => b.max < a.max ? b : a);
    fields[key] = { min:lower.min, max:upper.max, minSource:lower.minSource, maxSource:upper.maxSource,
      supported:limits.every(limit => limit.supported) && lower.min <= upper.max };
    if (limits.every(limit => limit.default !== undefined && limit.default === limits[0].default)) {
      fields[key].default = limits[0].default;
      fields[key].defaultSource = limits.every(limit => limit.defaultSource === 'model') ? 'model' : 'app';
    }
  }
  return fields;
}

export function modelParameters(input = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw fault('INVALID_PARAMETERS', 'Enter model parameters as an object.');
  const limits = parameterBounds;
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(limits, key) || !Number.isFinite(value) || value < limits[key][0] || value > limits[key][1]
      || (['max_tokens', 'seed', 'top_k'].includes(key) && !Number.isInteger(value)))
      throw fault('INVALID_PARAMETERS', 'Invalid model parameter: ' + key);
  }
  return { ...input };
}

export function parametersFor(provider, input) {
  const parameters = modelParameters(input);
  if (!Object.keys(parameters).length) return parameters;
  if (provider?.protocol !== 'openai-chat') throw fault('UNSUPPORTED_PARAMETERS', 'These controls require a Chat Completions model. Clear the overrides to use this provider.');
  if (parameters.max_tokens > provider.maxOutputTokensCeiling) throw fault('INVALID_PARAMETERS', `This model allows at most ${provider.maxOutputTokensCeiling} output tokens.`);
  if (('top_k' in parameters || 'min_p' in parameters) && provider.baseUrl !== 'https://api.venice.ai/api/v1')
    throw fault('UNSUPPORTED_PARAMETERS', 'Top k and min p require a Venice connection.');
  const limits = parameterLimits(provider).fields;
  for (const [key,value] of Object.entries(parameters)) if (value < limits[key].min || value > limits[key].max)
    throw fault('INVALID_PARAMETERS', `${key} must be between ${limits[key].min} and ${limits[key].max} for ${provider.label || provider.id}.`);
  return parameters;
}

// The immutable event ledger keeps every revision. Only the active branch is
// included in the transcript, model context and subsequent build requests.
export function activeHistory(task, events) {
  const ranges = task?.historyExclusions || [];
  return (Array.isArray(events) ? events : []).filter(event => event && !ranges.some(([start, end]) => event.seq >= start && event.seq <= end))
    .map(event => event.type === 'conversation.rewound' ? { ...event, data: { messageId: event.data?.messageId, filesRestored: false } } : event);
}
