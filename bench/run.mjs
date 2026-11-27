import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {adversarialCases} from './cases.mjs';

export async function implementationManifest() {
  const root=fileURLToPath(new URL('../',import.meta.url)),files=[];
  const digest=content=>createHash('sha256').update(content).digest('hex');
  const visit=async relative=>{
    const entries=await fs.readdir(path.join(root,relative),{withFileTypes:true});
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      const name=relative+'/'+entry.name;
      if(entry.isDirectory())await visit(name);
      else if(entry.isFile()&&entry.name.endsWith('.mjs'))files.push({path:name,sha256:digest(await fs.readFile(path.join(root,name)))});
    }
  };
  for(const directory of ['src','fixtures','bench','scripts']) {
    try { await visit(directory); }
    catch (err) { if (err?.code !== 'ENOENT') throw err; }
  }
  return {sha256:digest(JSON.stringify(files)),files};
}

export async function runBenchmark({dataDir,onProgress}={}) {
  const startedAt=new Date().toISOString();const start=performance.now();
  const implementation=await implementationManifest();
  const directory=path.resolve(dataDir || path.join('.g0dc0d3','benchmarks',startedAt.replaceAll(':','-')));
  await fs.mkdir(directory,{recursive:true});
  const cases=[];
  for(let index=0;index<adversarialCases.length;index++) {
    const definition=adversarialCases[index];const caseStart=performance.now();
    await onProgress?.({phase:'running',index:index+1,total:adversarialCases.length,id:definition.id,title:definition.title});
    let result;
    try {
      const caseDir=await fs.mkdtemp(path.join(directory,definition.id+'-'));
      const evidence=await definition.run(caseDir);
      result={id:definition.id,title:definition.title,category:definition.category,passed:true,evidence,durationMs:Math.round(performance.now()-caseStart)};
    } catch(error) {
      result={id:definition.id,title:definition.title,category:definition.category,passed:false,error:{name:error.name,message:error.message,code:error.code,stack:error.stack},durationMs:Math.round(performance.now()-caseStart)};
    }
    cases.push(result);
    await onProgress?.({phase:'settled',index:index+1,total:adversarialCases.length,id:definition.id,result});
  }
  const report={
    startedAt,finishedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-start),
    summary:{passed:cases.filter(result=>result.passed).length,failed:cases.filter(result=>!result.passed).length,total:cases.length},
    cases,evidenceKind:'scripted_fault_injection',
    disclaimer:'Deterministic scripted providers test controller behavior and independent fixture checks. Results do not measure real-model coding quality, jailbreak efficacy, or universal task success.',
    nodeVersion:process.version,implementation,
    implementationChangedDuringRun:implementation.sha256!==(await implementationManifest()).sha256
  };
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
  return report;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const index=process.argv.indexOf('--output');
  const output=index>=0?process.argv[index+1]:undefined;
  if(index>=0 && !output)throw new Error('--output requires a directory');
  const report=await runBenchmark({dataDir:output,onProgress:({phase,index,total,id,result})=>{
    if(phase==='settled')process.stderr.write(`${index}/${total} ${result.passed?'PASS':'FAIL'} ${id}${result.passed?'':': '+result.error.message}\n`);
  }});
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  process.exitCode=report.summary.failed?1:0;
}
