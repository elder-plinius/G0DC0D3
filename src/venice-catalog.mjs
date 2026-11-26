// Catalog choices are explicit chat or patch selections. Connected routes keep
// their own identities and credentials when the public catalog refreshes.
export const veniceEndpoint = 'https://api.venice.ai/api/v1';
const prefix = 'venice-catalog:';
export const isCatalogModel = id => typeof id === 'string' && id.startsWith(prefix);

export function createVeniceCatalog(providers, fetchCatalog = fetch, privacySettings = () => ({})) {
  const source = () => [...providers.values()].find(p => p.baseUrl === veniceEndpoint && p.protocol === 'openai-chat' && p.available && !p.closed && p.catalogChoice);
  let records = new Map(), expires = 0, pending, warning = '', fetchedAt = null;
  async function refresh() {
    try {
      const res = await fetchCatalog(veniceEndpoint + '/models?type=text', { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!res.ok) { await res.body?.cancel?.().catch(() => {}); throw new Error(); }
      const { data } = await res.json();
      if (!Array.isArray(data)) throw new Error();
      const next = new Map();
      for (const entry of data) {
        const spec = entry?.model_spec;
        if (entry?.type !== 'text' || !spec || spec.offline || spec.capabilities?.supportsE2EE || entry.id?.startsWith('e2ee-')) continue;
        if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/+~-]{0,159}$/.test(entry.id)) continue;
        const id = prefix + entry.id;
        const limit = Number.isInteger(spec.maxCompletionTokens) && spec.maxCompletionTokens > 0 ? Math.min(200000, spec.maxCompletionTokens) : 16384;
        const constraints = {};
        for (const key of ['temperature','top_p','max_tokens','seed','frequency_penalty','presence_penalty','top_k','min_p']) {
          const constraint = spec.constraints?.[key];
          if (!constraint || typeof constraint !== 'object') continue;
          constraints[key] = Object.fromEntries(['min','max','default'].filter(name => Number.isFinite(constraint[name])).map(name => [name,constraint[name]]));
        }
        const supportsReasoning = Boolean(spec.capabilities?.supportsReasoning);
        const supportsFunctionCalling = Boolean(spec.capabilities?.supportsFunctionCalling);
        const modelMetadata = { constraints, fetchedAt:new Date().toISOString(),
          supportsReasoning: Boolean(supportsReasoning),
          supportsFunctionCalling: Boolean(supportsFunctionCalling),
          ...(Number.isInteger(spec.availableContextTokens) && spec.availableContextTokens > 0 ? { contextWindow: spec.availableContextTokens } : {}),
          ...(Number.isInteger(spec.maxCompletionTokens) && spec.maxCompletionTokens > 0 ? {maxCompletionTokens:spec.maxCompletionTokens} : {}) };
        next.set(id, { id, model: entry.id, label: String(spec.name || entry.id).slice(0, 200), limit, supportsReasoning, supportsFunctionCalling, modelMetadata });
      }
      if (!next.size) throw new Error();
      records = next;
      fetchedAt = new Date().toISOString();
      warning = '';
      expires = Date.now() + 15 * 60000;
    } catch {
      warning = records.size ? 'Venice is unreachable. Showing the last catalog from this session.' : 'Could not load the Venice catalog. Refresh to try again.';
      expires = Date.now() + 30000;
    }
  }
  return {
    async list(force = false) {
      const connected = Boolean(source());
      if (privacySettings().localOnly) return { connected, models: connected ? [...records.values()] : [],
        warning: 'Local-only inference is enabled. Catalog refresh is paused.', fetchedAt, stale: true };
      if (connected && (force || Date.now() >= expires)) {
        pending ??= refresh().finally(() => { pending = null; });
        await pending;
      }
      for (const provider of providers.values()) if (provider.baseUrl === veniceEndpoint && provider.protocol === 'openai-chat')
        provider.modelMetadata = records.get(prefix + provider.model)?.modelMetadata;
      return { connected, models: connected ? [...records.values()] : [], warning: connected ? warning : '', fetchedAt, stale: connected && Boolean(warning) };
    },
    get(id) {
      const entry = records.get(id);
      return entry && source()?.catalogChoice(entry);
    },
  };
}
