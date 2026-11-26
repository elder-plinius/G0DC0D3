/** Invoked only by the fault suite; abrupt process death is deliberate. */
import {Runtime} from '../src/runtime.mjs';
import {evaluateTask} from '../src/evaluator.mjs';
import {createScriptedProviders} from './scripted.mjs';

const [dataDir,taskId,faultPoint='after_effect']=process.argv.slice(2);
if(!dataDir || !taskId)throw new Error('Expected data directory and persisted task ID');
const runtime=new Runtime({dataDir,providers:createScriptedProviders(),evaluator:evaluateTask,
  faultInjector:async point=>{if(point===faultPoint)process.exit(86);}
});
await runtime.resume(taskId);
await runtime.run(taskId);
await runtime.close();
throw new Error('Fault injector did not reach a write effect');
