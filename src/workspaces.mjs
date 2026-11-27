import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readBoundedFile } from './broker.mjs';
import { getFixture } from '../fixtures/index.mjs';
import { gitInit } from './git.mjs';

/** Start a conversation without importing or granting access to a project. */
export async function createConversationTask(runtime, dataDir, input = {}) {
  if (Object.keys(input).some(key => !['objective', 'title', 'providerIds', 'persona', 'effort', 'policy', 'answerRace', 'ultraplinian', 'generation', 'planMode', 'permissionRules', 'attachments'].includes(key)))
    throw Object.assign(new Error('Conversations accept objective, title, providerIds, persona, effort, policy, generation, planMode, permissionRules, attachments, ultraplinian and an optional answer race.'), { code: 'INVALID_CONVERSATION' });
  const objectiveLimit = typeof input.objective === 'string' && input.objective.includes('<attached_file ') ? 100000 : 30000;
  if (typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > objectiveLimit)
    throw Object.assign(new Error(`A message of 1–${objectiveLimit} characters is required.`), { code: 'INVALID_CONVERSATION' });
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200))
    throw Object.assign(new Error('Conversation title must be at most 200 characters.'), { code: 'INVALID_CONVERSATION' });
  const providerIds = input.providerIds;
  if (!Array.isArray(providerIds) || !providerIds.length || providerIds.length > 10 || providerIds.some(id => {
    const provider = typeof id === 'string' && runtime.selectedProvider(id, 'conversation');
    return !provider || !provider.kind || provider.kind === 'scripted' || provider.available === false;
  })) throw Object.assign(new Error('Choose a configured live model to start a conversation.'), { code: 'LIVE_PROVIDER_REQUIRED' });
  const workspace = path.join(path.resolve(dataDir), 'workspaces', randomUUID());
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  try { await gitInit(workspace); } catch {}
  try {
    return await runtime.createTask({
      title: input.title, objective: input.objective, workspace, workspaceKind: 'conversation',
      providers: providerIds, persona: input.persona, ...(input.effort !== undefined ? { effort: input.effort } : {}), answerRace: input.answerRace, generation: input.generation, policy: { requestTimeoutMs: 600000, ...input.policy },
      execution: { enabled: false, network: false }, checks: [], acceptance: { mode: 'owner' }, planMode: Boolean(input.planMode),
      ...(input.permissionRules !== undefined ? { permissionRules: input.permissionRules } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.ultraplinian ? { ultraplinian: true } : {}),
      constraints: ['No project is attached. Workspace tools can access only this conversation\'s isolated working folder.', 'Commands and network access are disabled unless the owner explicitly changes the execution grants.']
    });
  } catch (error) {
    await fs.rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

export async function createFixtureTask(runtime, dataDir, input = {}) {
  const fixture = getFixture(input.fixtureId || 'task-board');
  const workspace = path.join(path.resolve(dataDir), 'workspaces', randomUUID());
  await fs.mkdir(workspace, {recursive:true,mode:0o700});
  try {
    for (const [relative, content] of Object.entries(fixture.files)) {
      const filename = path.join(workspace,relative);
      await fs.mkdir(path.dirname(filename),{recursive:true});
      await fs.writeFile(filename,content,{mode:0o600});
    }
    try { await gitInit(workspace); } catch {}
    return await runtime.createTask({
      title:input.title || fixture.title,
      objective:input.objective || fixture.objective,
      constraints:fixture.constraints,
      workspace,fixtureId:fixture.id,acceptance:{checkType:fixture.checkType,fixtureVersion:fixture.version||1},
      providers:input.providerIds || ['scripted-primary','scripted-fallback'],
      policy:input.policy,execution:input.execution,checks:input.checks,persona:input.persona,scenario:input.scenario || 'normal',planMode:Boolean(input.planMode),
      ...(input.permissionRules !== undefined ? { permissionRules: input.permissionRules } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.ultraplinian ? { ultraplinian: true } : {})
    });
  } catch (error) {
    await fs.rm(workspace,{recursive:true,force:true});
    throw error;
  }
}

export function fileDiff(initialFiles, currentFiles) {
  const before = new Map(initialFiles.map(file => [file.path, file]));
  const after = new Map(currentFiles.map(file => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].sort()
    .filter(name => {
      const b = before.get(name);
      const a = after.get(name);
      if (!b || !a) return true;
      if (b.content !== a.content) return true;
      return Boolean(b.sha256 && a.sha256 && b.sha256 !== a.sha256);
    })
    .map(name => {
      const b = before.get(name);
      const a = after.get(name);
      const isBinary = (b && b.content === null) || (a && a.content === null);
      return {
        path: name,
        before: b?.content ?? null,
        after: a?.content ?? null,
        ...(isBinary ? { binary: true, beforeBytes: b?.bytes ?? null, afterBytes: a?.bytes ?? null } : {})
      };
    });
}

const sourceExtensions=new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.json','.md','.txt','.py','.rs','.go','.java','.c','.h','.cpp','.hpp','.css','.scss','.html','.vue','.svelte','.sql','.yaml','.yml','.toml','.xml','.sh','.swift','.kt','.rb','.php','.graphql','.proto','.ini','.cfg']);
const excludedDirs=new Set(['node_modules','vendor','dist','build','target','coverage','__pycache__']);
const specialNames=new Set(['Makefile','Dockerfile','LICENSE','NOTICE','Gemfile','Rakefile']);
const hash=content=>createHash('sha256').update(content).digest('hex');

export function publishablePath(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || /[\x00-\x1f\x7f]/.test(relative)) return false;
  const parts = relative.split('/');
  if (parts.some(name => !name || name.startsWith('.') || excludedDirs.has(name) || /(?:^|[._-])(?:secret|secrets|credentials|private[-_]?key)(?:[._-]|$)/i.test(name) || /\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(name))) return false;
  return sourceExtensions.has(path.extname(parts.at(-1)).toLowerCase()) || specialNames.has(parts.at(-1));
}

const CHECK_MANIFEST_PATHS = new Set(['package.json', 'pyproject.toml', 'pytest.ini', 'Cargo.toml', 'go.mod', 'Makefile']);

export function detectProjectChecks(files = []) {
  const checks = [];
  const seen = new Set();
  const add = (name, command, source) => {
    if (!command || seen.has(command)) return;
    seen.add(command);
    checks.push({ name, command, source });
  };
  const byPath = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    if (file && typeof file.path === 'string') byPath.set(file.path, file);
  }
  const pkg = byPath.get('package.json');
  if (pkg && typeof pkg.content === 'string') {
    try {
      const parsed = JSON.parse(pkg.content);
      const scripts = parsed?.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {};
      if (typeof scripts.test === 'string' && scripts.test.trim() && !/no test specified/i.test(scripts.test)) {
        add('Test', 'npm test', 'package.json');
      }
      if (typeof scripts.typecheck === 'string' && scripts.typecheck.trim()) {
        add('Typecheck', 'npm run typecheck', 'package.json');
      }
      if (typeof scripts.lint === 'string' && scripts.lint.trim()) {
        add('Lint', 'npm run lint', 'package.json');
      }
      if (typeof scripts.build === 'string' && scripts.build.trim()) {
        add('Build', 'npm run build', 'package.json');
      }
    } catch {}
  }
  if (byPath.has('pytest.ini')) {
    add('Pytest', 'pytest', 'pytest.ini');
  } else if (byPath.has('pyproject.toml')) {
    add('Pytest', 'pytest', 'pyproject.toml');
  }
  if (byPath.has('Cargo.toml')) {
    add('Cargo test', 'cargo test', 'Cargo.toml');
  }
  if (byPath.has('go.mod')) {
    add('Go test', 'go test ./...', 'go.mod');
  }
  const makefile = byPath.get('Makefile');
  if (makefile && typeof makefile.content === 'string' && /^test\s*:/m.test(makefile.content)) {
    add('Make test', 'make test', 'Makefile');
  }
  return checks;
}

/** Read a filtered source copy; reject observed symlinks and leave the original unchanged.
 * Revalidation catches ordinary ancestor changes; this is not fd-relative openat traversal.
 */
export async function previewWorkspace(sourcePath,{includeContent=false}={}) {
  if(typeof sourcePath!=='string'||!path.isAbsolute(sourcePath))throw new Error('Choose an absolute project directory');
  const root=await fs.realpath(sourcePath),stat=await fs.stat(root);
  if(!stat.isDirectory()||root===path.parse(root).root)throw new Error('Choose a project directory, not a filesystem root');
  const files=[],omitted=[],checkCandidates=[];let totalBytes=0,entries=0;
  async function verifyPath(full,expected) {
    const resolved=await fs.realpath(full);
    if(resolved!==full || !(resolved===root||resolved.startsWith(root+path.sep)))throw new Error('Project path changed or traverses a symlink during import');
    const current=await fs.lstat(full);
    if(expected&&(current.ino!==expected.ino||current.dev!==expected.dev))throw new Error('Project entry changed during import');
    return current;
  }
  async function walk(directory,relative='',depth=0) {
    const directoryStat=await verifyPath(directory);
    const names=(await fs.readdir(directory)).sort();
    await verifyPath(directory,directoryStat);
    for(const name of names) {
      if(++entries>10000)throw new Error('Project scan exceeds 10,000 entries; choose a smaller source directory');
      const rel=relative?`${relative}/${name}`:name,full=path.join(directory,name);
      const omit=reason=>omitted.push({path:rel,reason});
      if(name.startsWith('.')||excludedDirs.has(name)){omit('hidden, dependency, or generated path');continue;}
      if(/(?:^|[._-])(?:secret|secrets|credentials|private[-_]?key)(?:[._-]|$)/i.test(name)||/\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(name)){omit('credential or local-state filename');continue;}
      const before=await fs.lstat(full);
      if(before.isSymbolicLink()){omit('symlink');continue;}
      if(before.isDirectory()){if(depth>=16)omit('directory depth limit');else await walk(full,rel,depth+1);continue;}
      if(!before.isFile()){omit('special file');continue;}
      if(!sourceExtensions.has(path.extname(name).toLowerCase())&&!specialNames.has(name)){omit('unrecognized source extension');continue;}
      if(before.size>256*1024){omit('file exceeds 256 KiB');continue;}
      if(files.length>=200||totalBytes+before.size>2*1024*1024){omit('copy size limit');continue;}
      await verifyPath(full,before);
      const bytes=await readBoundedFile(full,256*1024,'READ_LIMIT',{expectedIdentity:before});
      const after=await verifyPath(full,before);
      if(before.mtimeMs!==after.mtimeMs||before.size!==after.size)throw new Error('Project file changed during import');
      if(bytes.length>256*1024||totalBytes+bytes.length>2*1024*1024){omit('copy size limit');continue;}
      let content;try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{omit('non-UTF-8 content');continue;}
      if(content.includes('\0')){omit('binary content');continue;}
      const file={path:rel,bytes:bytes.length,sha256:hash(bytes)};if(includeContent)file.content=content;
      if(CHECK_MANIFEST_PATHS.has(rel))checkCandidates.push({path:rel,content});
      files.push(file);totalBytes+=bytes.length;
    }
  }
  await walk(root);
  await verifyPath(root,stat);
  if(!files.length)throw new Error('No supported source files found in that directory');
  const snapshotHash=hash(JSON.stringify(files.map(({path,sha256})=>[path,sha256])));
  const suggestedChecks=detectProjectChecks(checkCandidates);
  return {sourcePath:root,sourceIdentity:{dev:stat.dev,ino:stat.ino,birthtimeMs:stat.birthtimeMs},files,omitted,totalBytes,snapshotHash,suggestedChecks,copyPolicy:'visible UTF-8 source files only; up to 200 files / 2 MiB / 256 KiB per file; hidden, generated, credential-named and linked paths excluded'};
}

export async function createImportedTask(runtime,dataDir,input) {
  if(typeof input.objective!=='string'||!input.objective.trim())throw new Error('Describe the change to make');
  const providerIds=input.providerIds||[];
  if(!providerIds.length||providerIds.some(id=>!runtime.providers.has(id)||runtime.providers.get(id).kind==='scripted'))throw new Error('Choose a configured live provider for your project');
  const capture=await previewWorkspace(input.sourcePath,{includeContent:true});
  if(input.previewHash&&input.previewHash!==capture.snapshotHash)throw new Error('Source files changed since preview; preview the copy again');
  const workspace=path.join(path.resolve(dataDir),'workspaces',randomUUID());await fs.mkdir(workspace,{recursive:true,mode:0o700});
  try {
    for(const file of capture.files){const full=path.join(workspace,file.path);await fs.mkdir(path.dirname(full),{recursive:true});await fs.writeFile(full,file.content,{mode:0o600});}
    try { await gitInit(workspace); } catch {}
    const manifest={...capture,files:capture.files.map(({content,...file})=>file)};
    const task=await runtime.createTask({title:input.title||path.basename(capture.sourcePath),objective:input.objective,workspace,providers:providerIds,policy:input.policy,execution:input.execution,checks:input.checks,persona:input.persona,...(input.effort !== undefined ? { effort: input.effort } : {}),planMode:Boolean(input.planMode),
      ...(input.permissionRules !== undefined ? { permissionRules: input.permissionRules } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.ultraplinian ? { ultraplinian: true } : {}),
      constraints:['Work only on the copied files. The original project must remain unchanged.',input.execution?.enabled ? 'Run commands only in the copied project through process.run, within the owner execution and network grants. This alpha supports foreground commands; do not launch detached/background daemons. Claim test evidence only from recorded results.' : 'Process execution is disabled unless the owner grants it. Do not claim tests were run without recorded execution evidence.','Read the import manifest: excluded or omitted files are unknown. Preserve existing public interfaces unless the objective requests a change.'],
      acceptance:{mode:'owner'},fixtureId:null});
    return runtime.store.updateTask(task.id,current=>{current.sourcePath=capture.sourcePath;current.importManifest=manifest;return current;},'workspace.imported',{sourcePath:capture.sourcePath,files:capture.files.length,omitted:capture.omitted.length,snapshotHash:capture.snapshotHash});
  } catch(error){await fs.rm(workspace,{recursive:true,force:true});throw error;}
}
