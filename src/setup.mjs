export const SETUP_VERSION = 1;
const statuses = new Set(['completed', 'deferred']);

export function createSetup(store) {
  const state = () => {
    const saved = store.getLocalState('setupAcknowledgement', null);
    return saved?.version === SETUP_VERSION && statuses.has(saved.status)
      ? { version: SETUP_VERSION, status: saved.status, updatedAt: saved.updatedAt }
      : { version: SETUP_VERSION, status: 'pending' };
  };
  return {
    state,
    acknowledge(input) {
      if (!input || Object.keys(input).some(key => !['version', 'status'].includes(key))
        || input.version !== SETUP_VERSION || !statuses.has(input.status))
        throw Object.assign(new Error('Choose Continue or Not now in the current setup screen.'), { status: 400, code: 'INVALID_SETUP' });
      const saved = { version: SETUP_VERSION, status: input.status, updatedAt: new Date().toISOString() };
      store.setLocalState('setupAcknowledgement', saved);
      return saved;
    }
  };
}
