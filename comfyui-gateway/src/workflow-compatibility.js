import {schemaInputs,schemaOptions} from './workflow-converter.js';

// Static diagnostics only. Custom VALIDATE_INPUTS functions and GPU execution are not invoked.
export function checkWorkflowCompatibility(graph,objectInfo={}) {
  const issues=[];
  for(const [id,node] of Object.entries(graph||{})) {
    const info=objectInfo[node.class_type], inputs=node.inputs||{};
    const add=(kind,input,message,value)=>issues.push({kind,node:id,classType:node.class_type,input,message,...(value===undefined?{}:{value})});
    if(!info) {add('node','',`缺少节点：${node.class_type}`);continue;}
    const specs=schemaInputs(info);
    function expand(group,prefix='') {
      for(const section of ['required','optional']) for(const [name,raw] of Object.entries(group?.[section]||{})) {
        const full=prefix+name,type=raw[0],opts=raw[1]||{};
        specs[full]={name:full,type,opts,required:section==='required'};
        if(type==='COMFY_DYNAMICCOMBO_V3') {
          const selected=opts.options?.find(x=>x.key===inputs[full]);
          if(selected?.inputs) expand(selected.inputs,`${full}.`);
        }
        if(type==='COMFY_AUTOGROW_V3') {
          // V3 serializes these as values.a / images.image_1, not a literal parent input.
          specs[full].required=false;
          const template=opts.template||{}, inner=Object.values({...template.input?.required,...template.input?.optional})[0];
          const keys=Object.keys(inputs).filter(k=>k.startsWith(`${full}.`));
          if(keys.length<(template.min||0)) add('required',full,`动态输入 ${full} 至少需要 ${template.min} 个连接`);
          if(inner) for(const key of keys) specs[key]={name:key,type:inner[0],opts:inner[1]||{},required:false};
        }
      }
    }
    expand(info.input);
    for(const spec of Object.values(specs)) if(spec.required && !(spec.name in inputs)) add('required',spec.name,`缺少必填输入：${node.class_type}.${spec.name}`);
    for(const [name,value] of Object.entries(inputs)) {
      const spec=specs[name];
      if(Array.isArray(value)&&value.length===2&&typeof value[0]==='string'&&Number.isInteger(value[1])) {
        const upstream=graph[value[0]], upinfo=objectInfo[upstream?.class_type];
        if(!upstream) add('link',name,`连接目标不存在：${value[0]}`);
        else if(upinfo && (value[1]<0||value[1]>=(upinfo.output?.length||0))) add('link',name,`输出端口不存在：${value[0]}:${value[1]}`);
        continue;
      }
      if(!spec) continue;
      const choices=schemaOptions(spec);
      if(choices?.length && !choices.includes(value)) {
        const kind=typeof value==='string'&&(/(?:ckpt|unet|diffusion|vae|clip|lora|model|control_net|gguf)/i.test(name)||/\.(safetensors|gguf|pth|ckpt|onnx)$/i.test(value))?'model':/image|audio|video/i.test(name)&&/load/i.test(node.class_type)?'media':'option';
        add(kind,name,`当前选项不可用：${node.class_type}.${name}`,value);
      }
      if(['INT','FLOAT'].includes(spec.type)) {
        if(value==null||typeof value==='object'||!Number.isFinite(Number(value))) add('type',name,`数值参数无效：${name}`,value);
        else if((typeof spec.opts.min==='number'&&Number(value)<spec.opts.min)||(typeof spec.opts.max==='number'&&Number(value)>spec.opts.max)) add('range',name,`数值超出范围：${name}`,value);
      }
      if(spec.type==='BOOLEAN'&&typeof value!=='boolean') add('type',name,`布尔参数无效：${name}`,value);
    }
  }
  return issues;
}
