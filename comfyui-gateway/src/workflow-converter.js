// Conversion uses saved graph data and the running ComfyUI schema; it never executes nodes.
export const CONVERSION_VERSION = 2;
const scalar = (type) => Array.isArray(type) || /^(INT|FLOAT|BOOLEAN|STRING|COMBO|COMFY_DYNAMICCOMBO_V3)$/.test(String(type));
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const virtual = new Set(['Note','MarkdownNote','Note Plus (mtb)','Label (rgthree)','Fast Groups Bypasser (rgthree)','Fast Groups Muter (rgthree)','Bookmark (rgthree)']);
const controls = new Set(['fixed','randomize','increment','decrement']);
const specialOrder = {
  KSampler: ['seed','control_after_generate','steps','cfg','sampler_name','scheduler','denoise'],
  KSamplerAdvanced: ['add_noise','noise_seed','control_after_generate','steps','cfg','sampler_name','scheduler','start_at_step','end_at_step','return_with_leftover_noise'],
  LoadImage: ['image','upload'],
  VHS_VideoCombine: ['frame_rate','loop_count','filename_prefix','format','pingpong','save_output'],
  MiniMaxH3Easy: ['mode','prompt','resolution','aspect_ratio','width','height','seconds','advanced','fps','keyframe_role','ref_image_size','reference_mention_mode'],
};
const easyAliases = {
  mode: {'参考生视频':'reference','Reference-to-video':'reference','图生或首尾帧':'image','图生或首尾帧视频':'image','I2V or First/Last Frame':'image'},
  keyframe_role: {'首帧优先':'first','First frame priority':'first','尾帧优先':'last','Last frame priority':'last'},
  ref_image_size: {'短边最大1K像素':'1k','Max 1K Short Edge':'1k','短边最大2K像素':'2k','Max 2K Short Edge':'2k'},
  reference_mention_mode: {'按文件名':'filename','By filename':'filename','按序号':'index','By index':'index'},
  resolution: {'Custom':'custom','自定义':'custom'},
};

export function schemaInputs(info) {
  const specs = {};
  for (const group of ['required','optional']) for (const [name, spec] of Object.entries(info?.input?.[group] || {})) {
    specs[name] = {name,type:spec[0],opts:spec[1] || {},required:group==='required'};
  }
  return specs;
}
export function schemaOptions(spec) {
  if (!spec) return null;
  if (Array.isArray(spec.type)) return spec.type;
  return Array.isArray(spec.opts?.options) ? spec.opts.options.map(x=>plain(x)?x.key:x) : null;
}
function normalizedValue(value, spec, node, warnings) {
  if(spec?.type==='BOOLEAN' && typeof value==='string') {
    if(['true','enabled','enable'].includes(value.toLowerCase())) return true;
    if(['false','disabled','disable'].includes(value.toLowerCase())) return false;
    if(node.type==='MinimaxH3LatentUpscaler3D' && value==='cuda' && ['enable_temporal_chunking','force_unload'].includes(spec.name)) {
      warnings.push(`已修复旧版放大节点 ${spec.name} 错存的 cuda 值，采用插件默认值 ${spec.opts.default}。`);
      return spec.opts.default;
    }
  }
  if (typeof value !== 'string') return value;
  if (node.type==='MiniMaxH3Easy') value=easyAliases[spec?.name]?.[value] ?? value;
  const options=schemaOptions(spec);
  if (!options?.length || options.includes(value)) return value;
  const pathKey=(x)=>String(x).replaceAll('\\','/').toLowerCase();
  const same=options.filter(x=>typeof x==='string'&&pathKey(x)===pathKey(value));
  if(same.length===1) return same[0];
  if(/\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|engine)$/i.test(value)) {
    const basename=pathKey(value).split('/').pop();
    const matches=options.filter(x=>typeof x==='string'&&pathKey(x).split('/').pop()===basename);
    if(matches.length===1) {
      warnings.push(`已匹配同名模型路径：${value} → ${matches[0]}`);
      return matches[0];
    }
  }
  const labels=options.filter(x=>typeof x==='string' && value.trim().startsWith(x) && /^[\s—–-]/.test(value.trim().slice(x.length)));
  return labels.length===1?labels[0]:value;
}
function linksFor(graph) {
  return new Map((graph.links || []).map(l=>Array.isArray(l)?[String(l[0]),{from:String(l[1]),slot:l[2],to:String(l[3]),toSlot:l[4]}]:[String(l.id),{from:String(l.origin_id),slot:l.origin_slot,to:String(l.target_id),toSlot:l.target_slot}]));
}
function savedWidgets(node, info, warnings) {
  const named={...(plain(node.widgets_values)?node.widgets_values:{}),...(plain(node.widgets_values_named)?node.widgets_values_named:{})};
  if(Object.keys(named).length) return named;
  const values=Array.isArray(node.widgets_values)?[...node.widgets_values]:[];
  const specs=schemaInputs(info);
  if(node.type==='MiniMaxH3Easy' && values[2]==null && schemaOptions(specs.resolution)?.includes(values[3])) {
    values.splice(2,1); warnings.push('已修复 MiniMaxH3Easy 旧版提示词控件造成的参数错位。');
  }
  const uiOrder=(node.inputs||[]).filter(i=>i.widget).map(i=>i.widget.name || i.name);
  const order=specialOrder[node.type] || (uiOrder.length?uiOrder:Object.values(specs).filter(s=>scalar(s.type)&&!s.opts.hidden).map(s=>s.name));
  let index=0;
  for(let n=0;n<order.length&&index<values.length;n++) {
    const name=order[n]; named[name]=values[index++];
    if(/^(seed|noise_seed)$/.test(name)&&order[n+1]!=='control_after_generate'&&controls.has(values[index])) index++;
  }
  return named;
}

export function convertSavedWorkflow(ui, objectInfo={}) {
  if(!Array.isArray(ui?.nodes)||!Array.isArray(ui?.links)) throw new Error('不是 ComfyUI 节点画布工作流');
  const warnings=[], workflow={}, contexts=[], definitions=new Map();
  function collect(graph) { for(const def of graph.definitions?.subgraphs||[]) { definitions.set(def.id,def); collect(def); } }
  collect(ui);
  function context(graph,prefix='',parent=null,instance=null,ancestors=[]) {
    if(ancestors.length>32) throw new Error('子图嵌套过深');
    const ctx={graph,prefix,parent,instance,nodes:new Map(graph.nodes.map(n=>[String(n.id),n])),links:linksFor(graph),children:new Map(),widgets:new Map()};
    contexts.push(ctx);
    for(const node of graph.nodes) {
      ctx.widgets.set(String(node.id),savedWidgets(node,objectInfo[node.type],warnings));
      const def=definitions.get(node.type);
      if(def && ![2,4].includes(Number(node.mode||0))) {
        if(ancestors.includes(def.id)) throw new Error('子图存在循环引用');
        ctx.children.set(String(node.id),context(def,`${prefix}${node.id}:`,ctx,node,[...ancestors,def.id]));
      }
    }
    return ctx;
  }
  const root=context(ui);
  function literal(ctx,node,name) {
    const values=ctx.widgets.get(String(node.id))||{};
    if(Object.hasOwn(values,name)) return {value:values[name]};
    return undefined;
  }
  function resolveLink(ctx,id,seen) {
    const link=ctx.links.get(String(id));
    return link?resolve(ctx,link.from,link.slot,seen):undefined;
  }
  function nodeInput(ctx,node,input,seen) {
    return input?.link!=null?resolveLink(ctx,input.link,seen):literal(ctx,node,input?.widget?.name||input?.name);
  }
  function resolve(ctx,id,slot=0,seen=new Set()) {
    const key=`${ctx.prefix}${id}/${slot}`;
    if(seen.has(key)) throw new Error(`连线存在循环：${key}`);
    seen=new Set(seen);seen.add(key);
    if(ctx.parent && String(id)===String(ctx.graph.inputNode?.id ?? -10)) {
      const definition=ctx.graph.inputs?.[slot];
      const input=ctx.instance.inputs?.find(i=>i.name===definition?.name) || ctx.instance.inputs?.[slot];
      return nodeInput(ctx.parent,ctx.instance,input,seen);
    }
    const node=ctx.nodes.get(String(id));
    if(!node || Number(node.mode)===2 || virtual.has(node.type)) return undefined;
    if(Number(node.mode)===4 || node.type==='Reroute' || node.type==='SetNode') {
      const type=node.outputs?.[slot]?.type;
      const same=(node.inputs||[]).filter(i=>i.link!=null && (i.type===type || String(i.type).split(',').includes(type) || i.type==='*'));
      const input=same[slot] || same[0] || (node.type==='Reroute'||node.type==='SetNode'?(node.inputs||[]).find(i=>i.link!=null):null);
      return input?nodeInput(ctx,node,input,seen):undefined;
    }
    if(node.type==='PrimitiveNode') {
      const values=ctx.widgets.get(String(id));
      return {value:values.value ?? node.widgets_values?.[0]};
    }
    if(node.type==='GetNode') {
      const name=node.widgets_values_named?.value ?? node.widgets_values?.[0];
      let scope=ctx;
      while(scope) {
        const matches=[...scope.nodes.values()].filter(n=>n.type==='SetNode'&&Number(n.mode||0)!==2&&(n.widgets_values_named?.value??n.widgets_values?.[0])===name);
        if(matches.length>1) throw new Error(`Get/Set 名称不唯一：${name}`);
        if(matches.length) return resolve(scope,String(matches[0].id),0,seen);
        scope=scope.parent;
      }
      warnings.push(`Get 节点 ${ctx.prefix}${id} 找不到对应 Set：${name}`);return undefined;
    }
    const child=ctx.children.get(String(id));
    if(child) {
      const output=child.graph.outputs?.[slot];
      const outputLink=(output?.linkIds||[]).map(x=>child.links.get(String(x))).find(Boolean) || [...child.links.values()].find(l=>l.to===String(child.graph.outputNode?.id??-20)&&Number(l.toSlot)===Number(slot));
      return outputLink?resolve(child,outputLink.from,outputLink.slot,seen):undefined;
    }
    return {link:[`${ctx.prefix}${id}`,Number(slot)||0]};
  }
  function set(inputs,name,value) {
    if(value?.link) inputs[name]=value.link;
    else if(value && value.value!==undefined) inputs[name]=value.value;
  }
  for(const ctx of contexts) for(const node of ctx.nodes.values()) {
    if([2,4].includes(Number(node.mode||0)) || virtual.has(node.type) || ['GetNode','SetNode','Reroute','PrimitiveNode'].includes(node.type) || definitions.has(node.type)) continue;
    const id=`${ctx.prefix}${node.id}`, info=objectInfo[node.type], specs=schemaInputs(info), inputs={};
    const widgets={...ctx.widgets.get(String(node.id))};
    if(node.type==='VHS_VideoCombine') for(const field of specs.format?.opts?.formats?.[widgets.format]||[]) {
      if(Array.isArray(field)) specs[field[0]]={name:field[0],type:field[1],opts:plain(field[2])?field[2]:{},required:false};
    }
    // Old LiteGraph proxy widgets keep their value on the inner node when the outer array is empty.
    if(ctx.instance) {
      const proxy=ctx.instance.properties?.proxyWidgets || [];
      const outer=ctx.parent.widgets.get(String(ctx.instance.id)) || {};
      for(let p=0;p<proxy.length;p++) if(String(proxy[p][0])===String(node.id)) {
        const outerInput=(ctx.instance.inputs||[]).filter(i=>i.widget)[p];
        const name=outerInput?.name;
        if(name && Object.hasOwn(outer,name)) widgets[proxy[p][1]]=outer[name];
        if(outerInput?.link!=null) set(inputs,proxy[p][1],nodeInput(ctx.parent,ctx.instance,outerInput,new Set()));
      }
    }
    for(const input of node.inputs||[]) if(input.link!=null && !(input.name in inputs)) set(inputs,input.name,resolveLink(ctx,input.link,new Set()));
    // Use Everywhere saves the exact virtual connections in graph.extra.ue_links.
    for(const link of ctx.graph.extra?.ue_links||[]) {
      if(String(link.downstream)!==String(node.id)) continue;
      const input=node.inputs?.[link.downstream_slot], controller=ctx.nodes.get(String(link.controller));
      if(!input || input.link!=null || input.name in inputs || !controller || [2,4].includes(Number(controller.mode||0))) continue;
      if(input.type!==link.type && input.type!=='*' && !String(input.type).split(',').includes(link.type)) continue;
      set(inputs,input.name,resolve(ctx,String(link.upstream),link.upstream_slot,new Set()));
    }
    for(const [name,value] of Object.entries(widgets)) {
      if(name in inputs || ['control_after_generate','upload','videopreview'].includes(name)) continue;
      const uiInput=node.inputs?.find(i=>i.name===name);
      const spec=specs[name] || (uiInput?.widget?{name,type:uiInput.type,opts:{}}:null);
      if(spec && scalar(spec.type)) inputs[name]=normalizedValue(value,spec,node,warnings);
    }
    for(const spec of Object.values(specs)) if(!(spec.name in inputs) && spec.required && scalar(spec.type) && Object.hasOwn(spec.opts,'default')) {
      const linked=node.inputs?.find(i=>i.name===spec.name)?.link!=null;
      if(!linked) inputs[spec.name]=normalizedValue(spec.opts.default,spec,node,warnings);
    }
    // Expand V3 dynamic-combo child names (format.codec, format.codec.encoding, ...).
    function expand(group,prefix='') {
      for(const [name,raw] of Object.entries({...group?.required,...group?.optional})) {
        const full=prefix+name,type=raw[0],opts=raw[1]||{};
        if(type==='COMFY_DYNAMICCOMBO_V3') {
          if(!(full in inputs) && Object.hasOwn(widgets,full)) inputs[full]=widgets[full];
          if(!(full in inputs) && !opts.hidden) inputs[full]=opts.default ?? opts.options?.[0]?.key;
          const selected=opts.options?.find(x=>x.key===inputs[full]);
          if(selected?.inputs) expand(selected.inputs,`${full}.`);
        } else if(prefix && !(full in inputs)) {
          if(Object.hasOwn(widgets,full)) inputs[full]=widgets[full];
          else if(Object.hasOwn(opts,'default')) inputs[full]=opts.default;
        }
      }
    }
    expand(info?.input);
    if(node.type==='MiniMaxH3Easy') {
      const media=(node.properties?.minimax_h3_virtual_media_links||[]).slice().sort((a,b)=>(a.order||0)-(b.order||0));
      const runtime=[];
      for(const item of media) {
        const endpoint=resolve(ctx,String(item.source_id),item.source_slot,new Set());
        if(endpoint?.link) {const index=runtime.length+1;inputs[`media_${index}`]=endpoint.link;inputs[`media_type_${index}`]=item.media_type||'image';runtime.push(item);}
      }
      const doc=node.properties?.minimax_h3_prompt_reference_doc;
      if(Array.isArray(doc?.parts)) {
        inputs.prompt=doc.parts.map(part=>{
          if(part.type==='dialogue') return `<d>${part.text||''}</d>`;
          if(part.type!=='mention') return part.text||'';
          const type=String(part.mediaType||'image').toLowerCase();
          let index=-1;
          if((inputs.reference_mention_mode==='index'||part.sourceId==null)&&Number(part.ordinal)>0) {
            let ordinal=0;
            index=runtime.findIndex(item=>String(item.media_type||'image').toLowerCase()===type && ++ordinal===Number(part.ordinal));
          }
          if(index<0&&part.sourceId!=null) index=runtime.findIndex(item=>String(item.source_id)===String(part.sourceId)&&Number(item.source_slot||0)===Number(part.sourceSlot||0)&&String(item.media_type||'image').toLowerCase()===type);
          return index>=0?`__MINIMAX_H3_REF_${index+1}__`:inputs.mode==='reference'?`__MINIMAX_H3_UNRESOLVED_REF_${type}__`:part.token||'';
        }).join('');
      }
    }
    // Normalize linked scalar values and unique same-file model paths too.
    for(const [name,value] of Object.entries(inputs)) if(specs[name]) inputs[name]=normalizedValue(value,specs[name],node,warnings);
    workflow[id]={class_type:node.type,inputs,_meta:{title:node.title||node._meta?.title||node.type,...(typeof info?.output_node==='boolean'?{output_node:info.output_node}:{}),source_node:id}};
    if(!info) warnings.push(`缺少节点定义：${node.type}（节点 ${id}）`);
  }
  if(!Object.keys(workflow).length) throw new Error('当前保存状态没有可执行节点，请启用需要的工作流分支');
  return {workflow,warnings:[...new Set(warnings)]};
}
