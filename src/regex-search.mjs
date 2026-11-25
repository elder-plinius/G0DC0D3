import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const fault = (code, message) => Object.assign(new Error(message), { code });

// Evaluate model-supplied expressions outside the server event loop. The worker
// receives only the broker's bounded, scoped snapshot and is always terminated.
export function regexSearch(files, query, limit, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(fault('STALE_RUN', 'Search was cancelled.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: 'repo.regex-search', files, query, limit },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 }
    });
    let settled = false;
    const finish = async (cause, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { await worker.terminate(); }
      catch (error) { cause ||= error; }
      if (cause) reject(cause); else resolve(result);
    };
    const abort = () => { void finish(fault('STALE_RUN', 'Search was cancelled.')); };
    const timer = setTimeout(() => {
      void finish(fault('SEARCH_TIMEOUT', 'Regular expression search exceeded 750 ms. Simplify the expression or use a literal search.'));
    }, 750);
    worker.once('message', message => {
      void finish(message.error ? fault(message.error.code, message.error.message) : null, message.result);
    });
    worker.once('error', cause => { void finish(fault('SEARCH_FAILED', cause.message)); });
    worker.once('exit', () => { void finish(fault('SEARCH_FAILED', 'Search worker exited before returning a result.')); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

if (!isMainThread && workerData?.kind === 'repo.regex-search') {
  try {
    const regex = new RegExp(workerData.query);
    const matches = [];
    let truncated = false;
    for (const file of workerData.files) {
      const lines = file.content.split('\n');
      for (let line = 0; line < lines.length; line++) {
        const found = regex.exec(lines[line]);
        if (!found) continue;
        if (matches.length === workerData.limit) { truncated = true; break; }
        matches.push({ path: file.path, line: line + 1, text: lines[line].slice(Math.max(0, found.index - 80), found.index + 240), sha256: file.sha256 });
      }
      if (truncated) break;
    }
    parentPort.postMessage({ result: { ok: true, matches, truncated } });
  } catch (cause) {
    parentPort.postMessage({ error: { code: 'INVALID_TOOL', message: `Invalid regular expression: ${cause.message}` } });
  }
}
