import {promises as fs} from 'node:fs';
import path from 'node:path';
import {getFixture} from '../fixtures/index.mjs';

export async function materializeFixture(id, workspace) {
  const fixture = getFixture(id);
  await fs.mkdir(workspace,{recursive:true});
  for (const [relative,content] of Object.entries(fixture.files)) {
    const file = path.join(workspace,relative);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,content);
  }
  return fixture;
}

export function fixtureTask(fixture,workspace,patch={}) {
  return {
    title:fixture.title,objective:fixture.objective,workspace,fixtureId:fixture.id,
    acceptance:{checkType:fixture.checkType,fixtureVersion:fixture.version||1},constraints:[...fixture.constraints],
    providers:['scripted-primary','scripted-fallback'],
    policy:{mode:'hybrid',maxAttempts:6,maxCalls:20,strategies:['continue','decompose','reproduce-first']},
    ...patch
  };
}

export async function waitUntil(predicate,{timeoutMs=3000}={}) {
  const started=Date.now();
  while (!await predicate()) {
    if (Date.now()-started>timeoutMs) throw new Error('Timed out waiting for test condition');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}
