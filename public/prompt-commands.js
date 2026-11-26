'use strict';

let promptLibrary = [], promptRevision = '', commandBeingEdited = null;
let libraryRequest = 0, writingCommand = false, revisionRequest = 0;
const commandTagPattern = /^(![A-Z][A-Z0-9_-]{0,30}\+?)(?:\s+([\s\S]*))?$/i;
function expandPromptCommand(message, limit) {
  const match = commandTagPattern.exec(message);
  if (!match) return message;
  const tag = match[1].toUpperCase();
  const command = promptLibrary.find(item => item.tag === tag);
  if (!command) return message;
  const expanded = [command.tag,command.prompt,match[2]?.trim()].filter(Boolean).join('\n\n');
  if (expanded.length > limit) throw new Error('The expanded command exceeds this message’s ' + limit.toLocaleString() + '-character limit. Shorten the instructions or message.');
  return expanded;
}

function showPromptLibrary(data) {
  promptLibrary = data.commands;
  promptRevision = data.revision;
  renderPromptList();
}
async function loadPromptLibrary(revision) {
  if (revision && revision === promptRevision) return;
  const request = ++libraryRequest, data = await api('/api/prompt-commands');
  if (request === libraryRequest) showPromptLibrary(data);
}
function renderPromptList() {
  const query = $('#prompt-search').value.trim().toLowerCase();
  const matches = promptLibrary.filter(c => (c.tag+' '+c.prompt).toLowerCase().includes(query));
  $('#prompt-list').innerHTML = matches.map(c =>
    '<div class="prompt-item"><button type="button" data-prompt-edit="'+escapeHTML(c.tag)+'"><strong>'+escapeHTML(c.tag)+'</strong><span>'+escapeHTML(c.prompt)+'</span></button>'+
    '<button type="button" class="button button-quiet" data-prompt-use="'+escapeHTML(c.tag)+'" aria-label="Use '+escapeHTML(c.tag)+' in chat">Use</button></div>'
  ).join('') || '<p class="field-help">'+(query?'No matching commands.':'Create a command to reuse a prompt across chats.')+'</p>';
}
function insertPromptTag(tag) {
  const input = $('#composer-input');
  input.value = tag + ' ' + input.value.replace(/^![A-Z][A-Z0-9_-]*\+?(?:\s+|$)/i,'');
  input.dispatchEvent(new Event('input',{bubbles:true}));
  input.focus();
}
function editPrompt(command) {
  revisionRequest++;
  commandBeingEdited = command || null;
  $('#prompt-library').hidden = true;
  $('#prompt-new').hidden = true;
  $('#prompt-editor').hidden = false;
  $('#prompt-tag').value = command?.tag || '!';
  $('#prompt-body').value = command?.prompt || '';
  $('#prompt-request').value = '';
  $('#prompt-proposal').hidden = true;
  $('#prompt-revision').open = false;
  $('#prompt-propose').disabled = false;
  $('#prompt-delete').hidden = !command;
  settingsFeedback('Save to update your command library.');
  (command ? $('#prompt-body') : $('#prompt-tag')).focus();
}
function closePromptEditor() {
  revisionRequest++;
  commandBeingEdited = null;
  $('#prompt-library').hidden = false;
  $('#prompt-editor').hidden = true;
  $('#prompt-new').hidden = false;
  renderPromptList();
  $('#prompt-new').focus({preventScroll:true});
}
async function savePrompt(remove) {
  if (writingCommand) return;
  const tag = remove ? commandBeingEdited.tag : $('#prompt-tag').value.trim().toUpperCase();
  const data = {tag, originalTag:commandBeingEdited?.tag || tag, version:commandBeingEdited?.version ?? null, prompt:$('#prompt-body').value};
  if (remove && !confirm('Delete '+tag+' from your command library?')) return;
  writingCommand = true;
  const controls = $$('#prompt-editor input, #prompt-editor textarea, #prompt-editor button');
  const disabled = controls.map(el=>el.disabled);
  controls.forEach(el=>el.disabled=true);
  try {
    const saved = await api('/api/prompt-commands',{method:remove?'DELETE':'PUT',body:JSON.stringify(data)});
    libraryRequest++;
    showPromptLibrary(saved);
    closePromptEditor();
    settingsFeedback(tag + (remove ? ' deleted.' : ' saved.'));
  } catch (error) { settingsFeedback(error.message,true); }
  finally { writingCommand=false; controls.forEach((el,i)=>el.disabled=disabled[i]); }
}
$('#prompt-search').addEventListener('input',renderPromptList);
$('#prompt-new').addEventListener('click',()=>editPrompt(null));
$('#prompt-back').addEventListener('click',closePromptEditor);
$('#prompt-list').addEventListener('click',event=>{
  const edit = event.target.closest('[data-prompt-edit]'), use = event.target.closest('[data-prompt-use]');
  if (edit) editPrompt(promptLibrary.find(c=>c.tag===edit.dataset.promptEdit));
  if (use) { settingsReturnFocus=$('#composer-input'); $('#settings-dialog').close(); insertPromptTag(use.dataset.promptUse); }
});
$('#prompt-editor').addEventListener('submit',event=>{ event.preventDefault(); savePrompt(false); });
$('#prompt-delete').addEventListener('click',()=>savePrompt(true));
$('#prompt-propose').addEventListener('click',async()=>{
  const prompt = $('#prompt-body').value, instruction = $('#prompt-request').value;
  if (!prompt.trim() || !instruction.trim()) { settingsFeedback('Enter instructions and describe the revision first.',true); return; }
  const request = ++revisionRequest;
  $('#prompt-propose').disabled = true;
  $('#prompt-proposal').hidden = true;
  settingsFeedback('Drafting with Venice…');
  try {
    const result = await api('/api/prompt-commands/revise',{method:'POST',body:JSON.stringify({prompt,instruction})});
    if (request !== revisionRequest) return;
    if (prompt !== $('#prompt-body').value || instruction !== $('#prompt-request').value) { settingsFeedback('The draft changed. Request a new revision.'); return; }
    $('#prompt-proposed').value=result.prompt;
    $('#prompt-proposal').hidden=false;
    settingsFeedback('Review the suggestion from '+result.model+'.');
    $('#prompt-proposed').focus();
  } catch(error) { if(request===revisionRequest)settingsFeedback(error.message,true); }
  finally { if(request===revisionRequest)$('#prompt-propose').disabled=false; }
});
$('#prompt-accept').addEventListener('click',()=>{
  $('#prompt-body').value=$('#prompt-proposed').value;
  $('#prompt-proposal').hidden=true;
  $('#prompt-revision').open=false;
  $('#prompt-body').focus();
  settingsFeedback('Revision added to the draft. Save to keep it.');
});
