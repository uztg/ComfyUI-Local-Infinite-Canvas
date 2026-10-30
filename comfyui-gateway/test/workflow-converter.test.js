import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {convertSavedWorkflow,CONVERSION_VERSION} from '../src/workflow-converter.js';
import {checkWorkflowCompatibility} from '../src/workflow-compatibility.js';
import {createFreeWorkflowStore} from '../src/free-workflows.js';

const info={
  Source:{input:{required:{value:['INT',{default:7}]}},output:['INT']},
  Sink:{input:{required:{value:['INT',{}]}},output:[],output_node:true},
  SaveImage:{input:{required:{images:['IMAGE',{}],filename_prefix:['STRING',{default:'out'}]}},output:[],output_node:true},
  Image:{input:{required:{}},output:['IMAGE']},
};
const n=(id,type,inputs=[],values=[])=>({id,type,inputs,widgets_values:values,outputs:[{type:'INT'}]});
const input=(name,type,link=null,widget=false)=>({name,type,link,...(widget?{widget:{name}}:{})});

test('Get/Set resolves names without emitting virtual nodes and detects cycles',()=>{
  const ui={nodes:[n(1,'Source',[input('value','INT',null,true)],[9]),n(2,'SetNode',[input('INT','INT',1)],['sample']),n(3,'GetNode',[],['sample']),n(4,'Sink',[input('value','INT',2)])],links:[[1,1,0,2,0,'INT'],[2,3,0,4,0,'INT']]};
  const {workflow}=convertSavedWorkflow(ui,info);
  assert.deepEqual(workflow['4'].inputs.value,['1',0]);assert.equal(workflow['2'],undefined);assert.equal(workflow['3'],undefined);
  ui.links[0][1]=3;
  assert.throws(()=>convertSavedWorkflow(ui,info),/循环/);
});

test('subgraph instances isolate IDs, use boundary widgets, and resolve output ports',()=>{
  const def={id:'sub',inputNode:{id:-10},outputNode:{id:-20},inputs:[{name:'amount',type:'INT'}],outputs:[{name:'number',linkIds:[2]}],nodes:[n(7,'Source',[input('value','INT',1,true)],[3])],links:[{id:1,origin_id:-10,origin_slot:0,target_id:7,target_slot:0,type:'INT'},{id:2,origin_id:7,origin_slot:0,target_id:-20,target_slot:0,type:'INT'}]};
  const ui={definitions:{subgraphs:[def]},nodes:[n(1,'sub',[input('amount','INT',null,true)],[12]),n(2,'sub',[input('amount','INT',null,true)],[24]),n(3,'Sink',[input('value','INT',5)])],links:[[5,2,0,3,0,'INT']]};
  const original=JSON.stringify(ui),{workflow}=convertSavedWorkflow(ui,info);
  assert.equal(workflow['1:7'].inputs.value,12);assert.equal(workflow['2:7'].inputs.value,24);assert.deepEqual(workflow['3'].inputs.value,['2:7',0]);assert.equal(JSON.stringify(ui),original);
});

test('Get in a subgraph resolves a Set in its parent scope',()=>{
  const def={id:'sub',outputNode:{id:-20},outputs:[{linkIds:[1]}],nodes:[n(1,'GetNode',[],['shared'])],links:[{id:1,origin_id:1,origin_slot:0,target_id:-20,target_slot:0}]};
  const ui={definitions:{subgraphs:[def]},nodes:[n(1,'Source',[input('value','INT',null,true)],[5]),n(2,'SetNode',[input('value','INT',1)],['shared']),n(3,'sub'),n(4,'Sink',[input('value','INT',2)])],links:[[1,1,0,2,0,'INT'],[2,3,0,4,0,'INT']]};
  assert.deepEqual(convertSavedWorkflow(ui,info).workflow['4'].inputs.value,['1',0]);
});

test('Use Everywhere restores saved wireless links but never replaces explicit links',()=>{
  const ui={nodes:[n(1,'Source',[input('value','INT',null,true)],[5]),n(2,'Anything Everywhere'),n(3,'Sink',[input('value','INT')]),n(4,'Sink',[input('value','INT',1)])],links:[[1,1,0,4,0,'INT']],extra:{ue_links:[{downstream:3,downstream_slot:0,upstream:'1',upstream_slot:0,controller:2,type:'INT'},{downstream:4,downstream_slot:0,upstream:'missing',upstream_slot:0,controller:2,type:'INT'}]}};
  const {workflow}=convertSavedWorkflow(ui,{...info,'Anything Everywhere':{input:{required:{}},output:[]}});
  assert.deepEqual(workflow['3'].inputs.value,['1',0]);assert.deepEqual(workflow['4'].inputs.value,['1',0]);
});

test('VHS dictionary preserves codec-specific settings and resolves image links',()=>{
  const vhs={input:{required:{images:['IMAGE',{}],format:[['video/h264-mp4'],{formats:{'video/h264-mp4':[['crf','INT',{default:20}],['pix_fmt',['yuv420p','yuv420p10le']]]}}],frame_rate:['FLOAT',{}],save_output:['BOOLEAN',{}]}},output:[],output_node:true};
  const ui={nodes:[n(1,'Image'),{...n(2,'VHS_VideoCombine',[input('images','IMAGE',1)]),widgets_values:{format:'video/h264-mp4',frame_rate:24,save_output:true,crf:18,pix_fmt:'yuv420p10le'}}],links:[[1,1,0,2,0,'IMAGE']]};
  const inputs=convertSavedWorkflow(ui,{...info,VHS_VideoCombine:vhs}).workflow['2'].inputs;
  assert.equal(inputs.crf,18);assert.equal(inputs.pix_fmt,'yuv420p10le');assert.deepEqual(inputs.images,['1',0]);
});

test('V3 dynamic inputs validate flattened names and optional zero-image groups',()=>{
  const schema={Math:{input:{required:{values:['COMFY_AUTOGROW_V3',{template:{input:{required:{value:['INT',{}]}},names:['a','b'],min:1}}]}},output:['INT']},Text:{input:{required:{images:['COMFY_AUTOGROW_V3',{template:{input:{required:{image:['IMAGE',{}]}},names:['image_1'],min:0}}]}},output:['STRING']}};
  const graph={1:{class_type:'Math',inputs:{'values.a':2}},2:{class_type:'Text',inputs:{}}};
  assert.deepEqual(checkWorkflowCompatibility(graph,schema),[]);
  delete graph[1].inputs['values.a'];assert.equal(checkWorkflowCompatibility(graph,schema)[0].kind,'required');
});

test('model path repair uses unique same-file matches and leaves different weights unresolved',()=>{
  const schema={Loader:{input:{required:{model:['COMBO',{options:['new/model.safetensors','other/variant.safetensors']}]}},output:['MODEL']}};
  const ui={nodes:[n(1,'Loader',[input('model','COMBO',null,true)],['old/model.safetensors']),n(2,'Loader',[input('model','COMBO',null,true)],['variant-int4.safetensors'])],links:[]};
  const {workflow}=convertSavedWorkflow(ui,schema);
  assert.equal(workflow[1].inputs.model,'new/model.safetensors');assert.equal(workflow[2].inputs.model,'variant-int4.safetensors');assert.equal(checkWorkflowCompatibility(workflow,schema).length,1);
});

test('MiniMax Easy restores old widgets, virtual media and extension runtime reference tokens',()=>{
  const names=['mode','prompt','resolution','aspect_ratio','width','height','seconds','advanced','fps','keyframe_role','ref_image_size','reference_mention_mode'];
  const required=Object.fromEntries(names.map(name=>[name,['STRING',{}]]));
  Object.assign(required,{mode:[['image','reference'],{}],resolution:[['480P','720P'],{}],keyframe_role:[['first','last'],{}],ref_image_size:[['1k','2k'],{}],reference_mention_mode:[['filename','index'],{}]});
  const node=n(2,'MiniMaxH3Easy',[],['参考生视频','old',null,'720P','9:16',1344,768,5,false,24,'首帧优先','短边最大1K像素','按文件名']);
  node.properties={minimax_h3_virtual_media_links:[{source_id:1,source_slot:0,media_type:'image',order:1}],minimax_h3_prompt_reference_doc:{parts:[{type:'mention',sourceId:1,sourceSlot:0,mediaType:'image'},{type:'dialogue',text:'hello'}]}};
  const inputs=convertSavedWorkflow({nodes:[n(1,'Image'),node],links:[]},{...info,MiniMaxH3Easy:{input:{required},output:['VIDEO']}}).workflow[2].inputs;
  assert.equal(inputs.mode,'reference');assert.equal(inputs.resolution,'720P');assert.equal(inputs.keyframe_role,'first');assert.equal(inputs.width,1344);assert.deepEqual(inputs.media_1,['1',0]);assert.equal(inputs.prompt,'__MINIMAX_H3_REF_1__<d>hello</d>');
});

test('bypass accepts union types and leaves muted branches excluded',()=>{
  const middle={...n(2,'Math',[input('values.a','FLOAT,INT,BOOLEAN',1)]),mode:4,outputs:[{type:'INT'}]};
  const ui={nodes:[n(1,'Source',[input('value','INT',null,true)],[4]),middle,n(3,'Sink',[input('value','INT',2)]),{...n(4,'Source'),mode:2}],links:[[1,1,0,2,0,'INT'],[2,2,0,3,0,'INT']]};
  const {workflow}=convertSavedWorkflow(ui,info);assert.deepEqual(workflow[3].inputs.value,['1',0]);assert.equal(workflow[4],undefined);
});

test('sync migrates unchanged source without changing IDs, name, archive or preset',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gateway-conversion-'));
  try {
    const ui={nodes:[n(1,'Image'),n(2,'SaveImage',[input('images','IMAGE',1)])],links:[[1,1,0,2,0,'IMAGE']]};
    await fs.writeFile(path.join(dir,'sample.json'),JSON.stringify(ui));
    const options={dataDir:dir,comfyWorkflowsDir:dir,comfy:{objectInfo:async()=>info}};
    const store=createFreeWorkflowStore(options);const entry=await store.importSource('sample.json');
    await store.rename(entry.id,'Renamed');await store.setArchived(entry.id,true,{seed:123,seedFixed:'true'});
    const file=path.join(dir,'free-workflows.json'),saved=JSON.parse(await fs.readFile(file,'utf8'));
    saved.workflows[0].conversionVersion=1;saved.workflows[0].workflow={};await fs.writeFile(file,JSON.stringify(saved));
    const upgraded=createFreeWorkflowStore(options);await upgraded.load();const result=await upgraded.sync(entry.id);
    assert.equal(result.changed,true);assert.equal(result.entry.conversionVersion,CONVERSION_VERSION);assert.equal(result.entry.id,entry.id);assert.equal(result.entry.name,'Renamed');assert.ok(result.entry.archivedAt);assert.equal(result.entry.preset.seed,'123');assert.deepEqual(result.entry.workflow[2].inputs.images,['1',0]);assert.equal(result.entry.compatibility.status,'passed');
    assert.equal((await upgraded.sync(entry.id)).changed,false);assert.equal((await upgraded.sync(entry.id,{force:true})).changed,true);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
