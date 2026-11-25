// Outcome descriptions are evidence for the UI, never instructions to reroute.
export function classifyProviderFailure(message, codes = []) {
  const text = String(message || ''), code = codes.filter(value => typeof value === 'string').join(' ').toUpperCase();
  // Content restrictions are routable when Ultra-Plinian recovery is active.
  // The old provider_policy code blocked all retry; CONTENT_RESTRICTION allows
  // the recovery loop to apply Parseltongue transformations and reframe.
  if (/CONTENT_FILTER|CONTENT_POLICY|SAFETY_(?:BLOCK|RESTRICTION)|POLICY_VIOLATION/.test(code)
    || /content (?:was |is )?flagged for (?:possible )?(?:cybersecurity|safety)|blocked (?:by|due to) (?:the |a )?(?:safety|content) (?:filter|policy)|violates? (?:our |the )?(?:usage|content|safety) policy/i.test(text))
    return { code: 'CONTENT_RESTRICTION', kind: 'refusal', retryable: true };
  if (/AUTHENTICATION|UNAUTHORIZED|INVALID_API_KEY|ACCOUNT_DEACTIVATED/.test(code)
    || /not logged in|authentication (?:failed|required)|invalid api key|please (?:log|sign) in|account (?:suspended|deactivated)|insufficient (?:credits|quota)|usage limit (?:reached|exceeded)/i.test(text))
    return { code: 'authentication', retryable: false };
  if (/RATE_LIMIT|TOO_MANY_REQUESTS|\b429\b/.test(code) || /rate limit(?:ed| exceeded)?|too many requests|(?:status|http)\s*429\b/i.test(text))
    return { code: 'rate_limit', retryable: true };
  if (/ETIMEDOUT|TIMEOUT|SERVICE_UNAVAILABLE|SERVER_OVERLOADED|INTERNAL_SERVER_ERROR/.test(code)
    || /request timed out|connection (?:reset|timed out)|service (?:temporarily )?unavailable|server (?:is )?overloaded|(?:status|http)\s*50[234]\b/i.test(text))
    return { code: 'PROVIDER_ERROR', retryable: true };
  return { code: 'provider_failure', retryable: false };
}

export function replyOutcome(response) {
  if (response?.type !== 'message') return null;
  if (response.finish === 'refusal') return { kind: 'declined', label: 'Request declined', source: 'provider' };
  const original = String(response.text || '');
  if (original.length > 4000) return null;
  const prose = original.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^\s*>.*$/gm, '').replace(/`[^`]*`|"[^"\n]*"|“[^”\n]*”/g, '').replace(/[‘’]/g, "'");
  if (/\bi (?:cannot|can't|won't|will not|am unable to)\s+(?:help(?! (?:but|wonder|notic|think|laugh))|assist|provide|comply|fulfill|implement|write|build|create)\b/i.test(prose))
    return { kind: 'declined', label: 'Request declined', source: 'text_heuristic' };
  if (/\bi(?:'m| am) not going to (?:build|create|write|help|assist|implement|provide)\b/i.test(prose))
    return { kind: 'declined', label: 'Request declined', source: 'text_heuristic' };
  if (/\bi (?:need|have) to stop here\b/i.test(prose) && /\b(?:harmful|malicious|illegal|unethical|cannot|can.?t|won.?t|inappropriate|not appropriate)\b/i.test(prose))
    return { kind: 'declined', label: 'Request declined', source: 'text_heuristic' };
  return null;
}

// Read-only transcript classification also applies to completed, historical chats.
export function displayReplyOutcome(response) {
  if (response?.type === 'message' && response.finish === 'length')
    return { kind: 'partial', label: 'Partial reply', source: 'provider' };
  const existing = replyOutcome(response);
  if (existing || response?.type !== 'message') return existing;
  const opening = String(response.text || '').trimStart().slice(0, 260).replace(/[‘’]/g, "'");
  if (/^(?:that|this)(?: request)? (?:isn't|is not) something (?:that )?I can (?:help|assist) (?:you )?with[.!?](?:\s|$)/i.test(opening))
    return {kind: 'declined', label: 'Request declined', source: 'text_heuristic'};
  return null;
}

// Match only the incident belonging to this dispatched response.
const declineIncident = incident => incident && (incident.kind === 'refusal' || incident.diagnosis === 'refusal' ||
  ['REFUSAL','CONTENT_RESTRICTION','PROVIDER_POLICY'].includes(String(incident.code).toUpperCase()));

export function displayOutcomes(events) {
  let response;
  return events.map(event => {
    if (['model.request', 'model.switched', 'providers.updated', 'user.message', 'user.messages.applied', 'task.completed'].includes(event.type)) response = null;
    if (event.type === 'model.response') {
      const data = event.data, reply = data.response;
      response = { ...event, data: { ...data, replyOutcome: displayReplyOutcome(reply) } };
      if (data.superseded) response = null;
      else if (reply?.type === 'error' && declineIncident(reply))
        response.data.replyOutcome = { kind: 'declined', label: 'Provider declined', source: 'provider' };
      return response || event;
    }
    const blocker = event.type === 'task.status' ? event.data?.blocker : null;
    const incident = event.type === 'recovery.started' ? event.data?.incident : blocker?.lastIncident || blocker;
    if (response && incident) {
      if (declineIncident(incident) && !response.data.replyOutcome)
        response.data.replyOutcome = {kind: 'declined', label: 'Request declined', source: 'recorded_incident'};
      response = null;
    }
    return event;
  });
}

export function taskOutcome(task) {
  if (task.status === 'completed' && task.completionKind === 'answered') {
    return task.replyOutcome?.kind === 'declined'
      ? { ...task.replyOutcome, detail: 'The model declined this request.' }
      : { kind: 'answered', label: 'Replied', detail: 'Response received. No code verification was performed.' };
  }
  if (!['blocked', 'failed', 'waiting_input'].includes(task.status) || !task.blocker) return null;
  const blocker = task.blocker, code = String(blocker.code || '').toUpperCase();
  if (code === 'RACE_DECLINED') return {kind:'declined',label:'Comparison stopped',detail:blocker.message};
  if (code === 'VENICE_OUTPUT_LIMIT') {
    const next = task.calls >= task.policy?.maxCalls ? 'Increase the chat’s call budget to continue.' : 'Send a follow-up to continue.';
    return {kind: 'partial', label: 'Output limit reached', detail: blocker.message + ' ' + next};
  }
  if (code === 'VENICE_RATE_LIMIT' || code === 'VENICE_RETRY_AFTER') {
    const limited = code === 'VENICE_RATE_LIMIT';
    const deadline = new Date(blocker.retryAt);
    const instruction = Number.isFinite(deadline.getTime())
      ? 'Resume after ' + deadline.toLocaleString(undefined, {dateStyle:'medium',timeStyle:'long'}) + '.'
      : 'Try again later.';
    return {kind: limited ? 'rate_limit' : 'provider_wait', label: limited ? 'Venice rate limit' : 'Venice requested a wait',
      detail: blocker.message + ' ' + instruction};
  }
  const legacyPolicy = code === 'PROVIDER_CONFIGURATION' && classifyProviderFailure(blocker.message).code === 'CONTENT_RESTRICTION';
  if (['NO_FALLBACK','NO_ELIGIBLE_FALLBACK'].includes(code) && task.providers?.length === 1) {
    const declined = declineIncident(blocker.lastIncident || blocker);
    return {kind: declined ? 'declined' : 'unavailable', label: declined ? 'Request declined' : 'No fallback selected',
      detail: (declined ? 'The model declined. ' : '') + 'Only one model was selected for this chat. The run stopped without switching.'};
  }
  if (declineIncident(blocker.lastIncident || blocker) || legacyPolicy)
    return { kind: 'declined', label: 'Request declined', detail: task.status === 'waiting_input' ? 'The model declined. Waiting for your input.' : 'The model declined. ' + (blocker.lastIncident ? blocker.message : 'This run has stopped.') };
  if (code === 'HTTP_402') return { kind: 'billing', label: 'Provider credit limit', detail: 'The request to ' + (blocker.providerId || task.providerId) + ' stopped with HTTP 402. Choose another connection in Models to continue.' };
  if (/AUTH|CREDENTIAL/.test(code)) return { kind: 'authentication', label: 'Sign-in required', detail: 'Automatic recovery stopped. Check the model connection and account access.' };
  if (code === 'PROVIDER_FAILURE') return { kind: 'provider_failure', label: 'Provider stopped', detail: 'Automatic recovery stopped because the provider failure was not identified as temporary.' };
  if (code === 'PROVIDER_CONFIGURATION') return { kind: 'configuration', label: 'Connection issue', detail: "Automatic recovery stopped. Check the provider’s installation and configuration." };
  if (blocker.diagnosis === 'permission') return { kind: 'permission', label: 'Permission required', detail: 'Automatic recovery stopped at a permission boundary.' };
  return null;
}
