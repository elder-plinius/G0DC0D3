// Conversation controls use the same runtime and durable event ledger as chat.
const generationFields = [
  ['temperature', 'Temperature', 0, 2, 'any'], ['top_p', 'Top p', 0, 1, 'any'],
  ['max_tokens', 'Output token limit', 1, 200000, 1], ['seed', 'Seed', 0, 2147483647, 1],
  ['frequency_penalty', 'Frequency penalty', -2, 2, 'any'], ['presence_penalty', 'Presence penalty', -2, 2, 'any'],
  ['top_k', 'Top k · Venice', 0, 1000, 1], ['min_p', 'Min p · Venice', 0, 1, 'any'],
];
const parameterDescriptions = {
  temperature: ['Response variety', 'Focused', 'Varied', .7], top_p: ['Probability sampling', 'Narrow', 'Broad', 1],
  max_tokens: ['Maximum response length', 'Shorter', 'Longer', 4096], seed: ['Repeatability hint', '', '', 42],
  frequency_penalty: ['Reduce repeated wording', 'Encourage', 'Discourage', 0], presence_penalty: ['Encourage new topics', 'Familiar', 'New', 0],
  top_k: ['Candidate token pool', 'Fewer', 'More', 40], min_p: ['Minimum relative probability', 'Open', 'Selective', .05],
};
// Range controls are a coarse input method. The named number input is always
// the authoritative value, so moving its thumb never rounds manually typed text.
window.ModelParameterControls = function(container) {
  const controls = new Map();
  let sequence = 0, currentIds = [], key = '', outputCap;
  container.classList.add('parameter-controls');
  for (const number of [...container.querySelectorAll('input[type=number][name]')]) {
    const name = number.name, definition = generationFields.find(field => field[0] === name);
    if (!definition) continue;
    const [,label,min,max,step] = definition, [description,low,high,initial] = parameterDescriptions[name];
    number.id ||= 'build-parameter-' + name;
    const card = document.createElement('section'); card.className = 'parameter-card';
    const helpId=number.id+'-help';
    card.innerHTML = `<header><label for="${number.id}">${escapeHTML(label)}</label><button type="button" class="parameter-default" aria-label="Use default ${escapeHTML(label)}">Default</button></header><p class="parameter-description">${description}</p><div class="parameter-value-row"><span class="parameter-input-slot"></span>${name === 'seed' ? '<button type="button" class="button button-secondary parameter-random">Randomize</button>' : `<input class="parameter-slider" type="range" aria-label="${escapeHTML(label)} slider" aria-describedby="${helpId}">`}</div>${name === 'seed' ? '' : `<div class="parameter-scale" aria-hidden="true"><span>${low}</span><span>${high}</span></div>`}<p class="parameter-range" id="${helpId}"></p>`;
    number.parentElement.replaceWith(card);
    card.querySelector('.parameter-input-slot').replaceWith(number);
    number.classList.add('parameter-number'); number.setAttribute('aria-describedby',helpId);
    const slider=card.querySelector('.parameter-slider'), reset=card.querySelector('.parameter-default'), random=card.querySelector('.parameter-random');
    const control={number,slider,reset,random,card,initial,integer:step!== 'any',limit:{min,max,supported:true,minSource:'app',maxSource:'app'},range:card.querySelector('.parameter-range')};
    controls.set(name,control);
    function sync() {
      const {limit}=control, hasValue=number.value!=='';
      const value=hasValue ? Number(number.value) : limit.default ?? initial;
      const invalid=hasValue && (!limit.supported || value<limit.min || value>limit.max);
      number.setCustomValidity(invalid ? !limit.supported ? 'Clear this override: it is not supported by the selected models.' : `Enter a value from ${limit.min} to ${limit.max}, or use Default.` : '');
      card.classList.toggle('parameter-overridden',hasValue); card.classList.toggle('parameter-invalid',invalid);
      reset.disabled=!hasValue; reset.textContent=hasValue?'Reset':'Default';
      number.readOnly=!limit.supported;
      if (random) random.disabled=!limit.supported;
      if (slider) {
        slider.disabled=!limit.supported || limit.min===limit.max;
        if(name==='max_tokens') {
          slider.min=0;slider.max=1000;slider.step=1;
          const ratio=Math.log(limit.max/Math.max(1,limit.min));
          slider.value=ratio ? Math.max(0,Math.min(1000,1000*Math.log(Math.max(limit.min,value)/limit.min)/ratio)) : 0;
        } else {
          slider.min=limit.min;slider.max=limit.max;slider.step=control.integer?1:.01;slider.value=Math.max(limit.min,Math.min(limit.max,value));
        }
        slider.setAttribute('aria-valuetext',hasValue?number.value:limit.default!==undefined?`Default: ${limit.default}`:'Model default; move slider to set an override');
      }
      number.placeholder=limit.default!==undefined?String(limit.default):'Default';
      const origins={model:'Model',api:'API',app:'App',connection:'Connection',workflow:'Workflow',verified:'Verified'};
      const source=limit.minSource===limit.maxSource?`${origins[limit.maxSource]} range`:`${limit.minSource==='verified'?'Verified min · ':''}${origins[limit.maxSource]} max`;
      control.range.textContent=!limit.supported?'Not supported by this selection':`${limit.min.toLocaleString()}–${limit.max.toLocaleString()} · ${source}${limit.default!==undefined?` · ${limit.defaultSource==='model'?'Model':'App'} default ${limit.default}`:''}${invalid?' · Value outside range':''}`;
    }
    control.sync=sync;
    number.addEventListener('input',sync);
    slider?.addEventListener('input',()=>{
      const {min,max}=control.limit;
      number.value=name==='max_tokens'?String(Math.round(min*Math.pow(max/min,Number(slider.value)/1000))):slider.value;
      number.dispatchEvent(new Event('input',{bubbles:true}));
    });
    reset.addEventListener('click',()=>{number.value='';number.dispatchEvent(new Event('input',{bubbles:true}));});
    random?.addEventListener('click',()=>{const sample=crypto.getRandomValues(new Uint32Array(1))[0];number.value=String(control.limit.min+sample%(control.limit.max-control.limit.min+1));number.dispatchEvent(new Event('input',{bubbles:true}));});
    sync();
  }
  const bar=document.createElement('div');bar.className='parameter-metadata';
  bar.innerHTML='<span role="status"></span><button type="button" class="button button-quiet">Refresh limits</button>';
  container.before(bar);
  const status=bar.querySelector('span'), refresh=bar.querySelector('button');
  async function load(ids,{force=false,cap}={}) {
    const request=++sequence;currentIds=[...new Set(ids)];outputCap=cap;key=JSON.stringify([currentIds,cap]);
    if(!currentIds.length){refresh.disabled=false;status.textContent='Select a model to load its limits.';return;}
    refresh.disabled=true;status.textContent='Checking selected model limits…';
    try {
      const result=await api('/api/providers/parameters?ids='+encodeURIComponent(currentIds.join(','))+(force?'&refresh=1':''));
      if(request!==sequence)return;
      for(const [name,control] of controls) {
        const limit={...result.fields[name]};
        if(name==='max_tokens' && cap && cap<limit.max){limit.max=cap;limit.maxSource='workflow';if(limit.default>cap)limit.default=cap;}
        control.limit=limit;control.number.min=limit.min;control.number.max=limit.max;control.sync();
      }
      const names=result.models.map(model=>model.label).join(' + ');
      const time=result.fetchedAt?` · refreshed ${new Date(result.fetchedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`:'';
      status.textContent=`${names}${result.models.length>1?' · shared ranges':''}${result.stale?' · cached limits':time}. Published or verified limits where available; API/app ranges elsewhere.${result.warning?' '+result.warning:''}`;
    } catch(error) {if(request===sequence)status.textContent='Could not refresh limits. Keeping the displayed ranges. '+error.message;}
    finally {if(request===sequence)refresh.disabled=false;}
  }
  refresh.addEventListener('click',()=>load(currentIds,{force:true,cap:outputCap}));
  setInterval(()=>{if(currentIds.length && !document.hidden && container.getClientRects().length)load(currentIds,{cap:outputCap});},60000);
  return {load,sync:()=>{for(const control of controls.values())control.sync();},get key(){return key;}};
};

let chatEditContext = null, generationContext = null;
let generationControls;
function generationDefaults() {
  try { return JSON.parse(localStorage.getItem('g0dc0d3.generation.v1') || '{}'); } catch { return {}; }
}
document.body.insertAdjacentHTML('beforeend', `
  <dialog id="chat-edit-dialog" class="modal conversation-edit-modal" aria-labelledby="chat-edit-title"><form id="chat-edit-form">
    <div class="modal-header"><h2 id="chat-edit-title">Edit message</h2><button type="button" class="icon-button" data-close="chat-edit-dialog" aria-label="Close message editor">×</button></div>
    <p id="chat-edit-help" class="field-help"></p><label class="field-label" for="chat-edit-text">Message</label><textarea id="chat-edit-text" rows="8" required></textarea>
    <p id="chat-edit-error" class="field-help" role="alert"></p><div class="conversation-dialog-actions"><button type="button" class="button button-secondary" id="chat-rewind">Rewind here</button><button type="submit" class="button button-primary" id="chat-edit-save">Save & regenerate</button></div>
  </form></dialog>
  <dialog id="generation-dialog" class="modal generation-modal" aria-labelledby="generation-title"><form id="generation-form">
    <div class="modal-header"><h2 id="generation-title">Model controls</h2><button type="button" class="icon-button" data-close="generation-dialog" aria-label="Close model controls">×</button></div>
    <p class="field-help" id="generation-help"></p><div class="generation-fields">${generationFields.map(([key,label,min,max,step]) => `<label class="field-label" for="generation-${key}">${label}<input id="generation-${key}" name="${key}" type="number" min="${min}" max="${max}" step="${step}" placeholder="Model default"></label>`).join('')}</div>
    <p class="field-help">Drag a slider or type an exact value. Reset leaves the parameter at its default. Model limits are refreshed automatically. Seed is a repeatability hint; results may still vary.</p>
    <p id="generation-error" class="field-help" role="alert"></p><div class="conversation-dialog-actions"><button type="button" id="generation-reset" class="button button-secondary">Use model defaults</button><button type="submit" class="button button-primary">Save controls</button></div>
  </form></dialog>`);

function renderConversationControls(task) {
  if ($('#generation-dialog').open && generationContext?.taskId === task?.id) refreshGenerationLimits(task);
  const queued = Boolean(task && (ACTIVE.has(task.status) || task.pendingMessages?.length || task.deferredMessages?.length));
  $('#composer-delivery-label').hidden = !queued;
  const steer = $('#composer-delivery').value === 'steer';
  $('#composer-delivery-help').textContent = queued ? steer ? 'Applies after the current request or tool.' : 'Runs after the current turn finishes.' : '';
  $('#composer-parameters').disabled = Boolean(task && task.status === 'cancelled');
  const count = Object.keys(task?.generation || (!task ? generationDefaults() : {})).length;
  $('#composer-parameters').textContent = count ? `Model controls · ${count}` : 'Model controls';
}
generationControls=window.ModelParameterControls($('#generation-dialog .generation-fields'));
$('#composer-delivery').addEventListener('change', renderComposer);
function refreshGenerationLimits(task, force=false) {
  const race=task?.answerRace || (!task ? RecoveryUI.preferences().answerRace : null);
  const ids=[...new Set([...(task?.providers || newConversationProviders()),...(race?.models || [])])];
  const cap=race?2000:undefined;
  if(force || generationControls.key!==JSON.stringify([ids,cap]))generationControls.load(ids,{cap});
}

function renderConversationQueue(task) {
  return [['pendingMessages','Steering','Applied together at the next request or tool boundary.'],['deferredMessages','Queued','Each message starts a separate turn after the current turn finishes.']].map(([field,title,help]) => {
    const queue = task[field] || [];
    if (!queue.length) return '';
    return `<section class="queued-instructions" aria-label="${title} messages"><h3>${title} · ${queue.length}</h3><p>${task.status === 'cancelled' ? 'Cancelled before application.' : help}</p>${queue.map((item,i) => `<article class="queued-instruction" data-queue-id="${escapeHTML(item.id)}"><header><strong>${title === 'Queued' ? 'Turn' : 'Instruction'} ${i+1}</strong><div class="queue-actions"><button type="button" class="button button-quiet" data-edit-queued="${escapeHTML(item.id)}">Edit</button><button type="button" class="button button-quiet" data-move-queued="${escapeHTML(item.id)}" data-direction="-1" aria-label="Move message ${i+1} up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="button button-quiet" data-move-queued="${escapeHTML(item.id)}" data-direction="1" aria-label="Move message ${i+1} down" ${i === queue.length-1 ? 'disabled' : ''}>↓</button><button type="button" class="button button-quiet" data-remove-message="${escapeHTML(item.id)}">Remove</button></div></header><div class="queued-text" tabindex="0">${escapeHTML(item.message)}</div></article>`).join('')}</section>`;
  }).join('');
}

function openChatEdit(messageId, queued = false) {
  const task = selectedData?.task;
  if (!task) return;
  if (!queued && (ACTIVE.has(task.status) || task.draining || isCrewBusy(task))) { toast('Pause the current turn before editing its history.'); return; }
  const source = queued ? [...(task.pendingMessages || []), ...(task.deferredMessages || [])] : task.followups || [];
  const message = messageId === 'objective' ? task.objective : source.find(item => item.id === messageId)?.message;
  if (message === undefined) { toast('This message has already changed. Refreshing the conversation.'); refresh(); return; }
  chatEditContext = { taskId: task.id, messageId, message, queued, revision: task.conversationRevision || 0 };
  $('#chat-edit-title').textContent = queued ? 'Edit queued message' : 'Edit or rewind chat';
  $('#chat-edit-help').textContent = queued ? 'Your change keeps this message in its current queue position.' : 'Continue from this message. Later replies leave the active conversation and remain in the full history export. Repository files stay as they are.';
  $('#chat-edit-text').value = message;
  $('#chat-edit-text').maxLength = message.includes('<attached_file ') ? 100000 : (messageId === 'objective' ? 30000 : 12000);
  $('#chat-edit-error').textContent = '';
  $('#chat-rewind').hidden = queued;
  $('#chat-edit-save').textContent = queued ? 'Save message' : 'Save & regenerate';
  $('#chat-edit-dialog').showModal();
  $('#chat-edit-text').focus();
}
function openLatestChatEdit() {
  const task = selectedData?.task;
  if (task?.workspaceKind === 'conversation') openChatEdit(task.followups?.at(-1)?.id || 'objective');
}
async function saveChatEdit(regenerate) {
  const context = chatEditContext;
  if (!context || !$('#chat-edit-form').reportValidity()) return;
  const buttons = [...$('#chat-edit-form').querySelectorAll('button')];
  buttons.forEach(button => button.disabled = true);
  try {
    const body = context.queued ? { messageId: context.messageId, expectedMessage: context.message, message: $('#chat-edit-text').value } : { messageId: context.messageId, revision: context.revision, message: $('#chat-edit-text').value, regenerate };
    await api(`/api/tasks/${encodeURIComponent(context.taskId)}/${context.queued ? 'message' : 'rewind'}`, { method: context.queued ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    $('#chat-edit-dialog').close();
    await refresh();
    if (!context.queued && !regenerate) {
      toast('Conversation rewound. Send a follow-up or click Resume when ready.');
      $('#composer-input')?.focus();
    }
  } catch (error) { $('#chat-edit-error').textContent = error.message; }
  finally { buttons.forEach(button => button.disabled = false); }
}
$('#chat-edit-form').addEventListener('submit', event => { event.preventDefault(); saveChatEdit(true); });
$('#chat-edit-text').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); saveChatEdit(true); }
});
$('#chat-rewind').addEventListener('click', () => saveChatEdit(false));
document.addEventListener('click', async event => {
  const chat = event.target.closest('[data-edit-chat]'), queued = event.target.closest('[data-edit-queued]'), move = event.target.closest('[data-move-queued]');
  if (chat) openChatEdit(chat.dataset.editChat.startsWith('objective-') ? 'objective' : chat.dataset.editChat.slice('followup-'.length));
  if (queued) openChatEdit(queued.dataset.editQueued, true);
  if (move) {
    const task = selectedData?.task, item = [...(task?.pendingMessages || []), ...(task?.deferredMessages || [])].find(item => item.id === move.dataset.moveQueued);
    if (!item) return;
    move.disabled = true;
    try { await api(`/api/tasks/${encodeURIComponent(task.id)}/message`, { method:'PATCH', body:JSON.stringify({ messageId:item.id, expectedMessage:item.message, direction:Number(move.dataset.direction) }) }); await refresh(); }
    catch (error) { toast(error.message); move.disabled = false; }
  }
});
$('#composer-input').addEventListener('keydown', event => {
  if (event.key === 'ArrowUp' && !event.target.value && !event.altKey && !event.metaKey && !event.ctrlKey && selectedData?.task?.workspaceKind === 'conversation') { event.preventDefault(); openLatestChatEdit(); }
});
$('#composer-parameters').addEventListener('click', () => {
  const task = selectedData?.task;
  generationContext = task ? { taskId: task.id } : {};
  const current = task?.generation || generationDefaults();
  for (const [key] of generationFields) $(`#generation-${key}`).value = current[key] ?? '';
  const runningNow = Boolean(task && (ACTIVE.has(task.status) || task.draining));
  $('#generation-help').textContent = task
    ? (runningNow
        ? 'Inferencing now — saved changes take effect automatically on the next turn or sent message.'
        : 'Applies to the next requests in this chat. Your system prompt and model route remain selected.')
    : 'Default controls for new chats on this device. Supported by OpenAI, Anthropic, OpenRouter, Venice, Gemini, and local API models (CLI subscriptions use the Effort control and subscription settings).';
  $('#generation-error').textContent = '';
  generationControls.sync();
  $('#generation-dialog').showModal();
  refreshGenerationLimits(task,true);
});
$('#generation-reset').addEventListener('click', () => { for (const [key] of generationFields) $(`#generation-${key}`).value = ''; generationControls.sync(); });
$('#generation-form').addEventListener('submit', async event => {
  event.preventDefault();
  const parameters = {};
  for (const [key, value] of new FormData(event.target)) if (value !== '') parameters[key] = Number(value);
  const submit = event.target.querySelector('[type=submit]'); submit.disabled = true;
  try {
    const activeTask = selectedData?.task;
    const runningNow = Boolean(activeTask && activeTask.id === generationContext.taskId && (ACTIVE.has(activeTask.status) || activeTask.draining));
    if (generationContext.taskId) await api(`/api/tasks/${encodeURIComponent(generationContext.taskId)}/generation`, { method:'PATCH', body:JSON.stringify(parameters) });
    else localStorage.setItem('g0dc0d3.generation.v1', JSON.stringify(parameters));
    $('#generation-dialog').close(); await refresh(); renderComposer();
    if (generationContext.taskId) toast(runningNow ? 'Model controls saved — applies to next turn.' : 'Model controls saved.');
  } catch (error) { $('#generation-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
