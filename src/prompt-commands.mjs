import { randomUUID } from 'node:crypto';
import { veniceEndpoint } from './venice-catalog.mjs';

const starters = [
  ['!GRADE', 'Evaluate the work against the supplied rubric. If there is no rubric, state the criteria first. Score each criterion, cite evidence, and suggest the most valuable revision.'],
  ['!SOCRATIC', 'Help me examine the idea through questions. Start with one question about its main assumption. Use my answer to decide what to ask next.'],
  ['!COUNCIL', 'Consider the question from three relevant professional perspectives. Give each a concrete observation, identify their disagreement, and end with a recommendation.'],
];
const key = 'prompt_commands_v1';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function field(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw fail(label + ' must contain between 1 and ' + max + ' characters.');
  return value.trim();
}
function tag(value) {
  if (typeof value !== 'string' || !/^![A-Z][A-Z0-9_-]{0,30}\+?$/.test(value))
    throw fail('Use a tag beginning with ! and an uppercase letter, such as !GRADE.');
  return value;
}

export function createPromptCommands(store) {
  const read = store.db.prepare('SELECT data FROM local_state WHERE key=?');
  const write = store.db.prepare('UPDATE local_state SET data=? WHERE key=?');
  store.db.prepare('INSERT OR IGNORE INTO local_state(key,data) VALUES(?,?)').run(key, JSON.stringify(
    starters.map(([tag, prompt]) => ({tag, prompt, version:randomUUID()}))
  ));
  const list = () => JSON.parse(read.get(key).data);
  let revision = randomUUID();
  function change(body, remove = false) {
    const result = store.transaction(() => {
      const commands = list(), name = tag(body.tag);
      const original = body.originalTag === undefined ? name : tag(body.originalTag);
      const index = commands.findIndex(command => command.tag === original);
      if ((commands[index]?.version ?? null) !== body.version || (remove && index < 0))
        throw fail('This command changed in another window. Reopen it to edit the latest version.', 409);
      if (remove) commands.splice(index, 1);
      else {
        if (original !== name && commands.some(command => command.tag === name)) throw fail('That tag already exists.', 409);
        const updated = {tag:name, prompt:field(body.prompt,'Prompt',6000), version:randomUUID()};
        if (index >= 0) commands[index] = updated;
        else {
          if (commands.length >= 128) throw fail('The library holds up to 128 commands.');
          commands.push(updated);
        }
      }
      commands.sort((a,b) => a.tag.localeCompare(b.tag));
      write.run(JSON.stringify(commands),key);
      return commands;
    });
    revision = randomUUID();
    return result;
  }
  return {list, change, get revision() { return revision; }};
}

export async function revisePromptCommand(providers, body, outboundOpts = {}) {
  const prompt = field(body.prompt,'Prompt',6000), instruction = field(body.instruction,'Revision request',2000);
  const provider = [...providers.values()].find(p => p.baseUrl === veniceEndpoint && p.protocol === 'openai-chat' && p.available && !p.closed && p.catalogChat);
  if (!provider) throw fail('Connect Venice in Models to draft a revision.', 409);
  const objective = 'Edit the reusable prompt in the following JSON according to the revision request. Return only the revised instructions as plain text. Do not carry out the prompt itself.\n' + JSON.stringify({prompt, instruction});
  const choice = { ...provider, model: provider.model, maxOutputTokens: Math.min(provider.maxOutputTokens, 2000) };
  const result = await provider.catalogChat(choice, { task: { objective, persona: 'focused' }, history: [] }, AbortSignal.timeout(60000), outboundOpts);
  if (result.type !== 'message' || result.finish !== 'done') {
    const status = result.code === 'PRIVACY_LOCAL_ONLY' || result.code === 'PRIVACY_STRICT_ZDR' ? 403 : 502;
    throw fail(result.message || 'Venice could not return a complete revision.', status);
  }
  return {prompt:field(result.text,'Proposed prompt',6000), model:provider.model};
}
