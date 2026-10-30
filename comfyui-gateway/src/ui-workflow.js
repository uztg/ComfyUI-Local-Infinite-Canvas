import { convertSavedWorkflow } from "./workflow-converter.js";
import { isUiWorkflow } from "./registry.js";
import { isPlainObject } from "./util.js";

function isImageOutputClass(classType) {
  return /^SaveImage$/i.test(classType) || /PreviewImage$/i.test(classType) || /(?:save|output).*(?:image|img)/i.test(classType) || /(?:image|img).*(?:save|output)/i.test(classType);
}

function isVideoOutputClass(classType) {
  return /SaveVideo|VHS_VideoCombine|SaveWebM/i.test(classType);
}
const BASIC_WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

// ResolutionSelector and similar combo nodes use labels like "16:9 (Widescreen)".
export function canonicalAspectRatio(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)/i);
  if (!match) return "";
  return `${Number(match[1])}:${Number(match[2])}`;
}

function comboOptions(objectInfo, classType, inputName) {
  const input = objectInfo?.[classType]?.input;
  const spec = input?.required?.[inputName] ?? input?.optional?.[inputName];
  if (Array.isArray(spec?.[0])) return spec[0];
  if (Array.isArray(spec) && Array.isArray(spec[1]?.options)) return spec[1].options;
  if (Array.isArray(spec?.options)) return spec.options;
  return [];
}

function normalizeType(value) {
  if (Array.isArray(value)) return "COMBO";
  if (Array.isArray(value?.options)) return "COMBO";
  return String(value || "");
}

function inputSpecs(objectInfo, classType) {
  const info = objectInfo?.[classType];
  if (!info?.input) return [];
  const specs = [];
  for (const group of ["required", "optional"]) {
    for (const [name, value] of Object.entries(info.input[group] || {})) {
      specs.push({
        name,
        type: normalizeType(Array.isArray(value) ? value[0] : value?.type),
        opts: Array.isArray(value) ? value[1] || {} : value || {},
        required: group === "required",
      });
    }
  }
  return specs;
}

const TEXTISH_INPUT_NAMES = new Set(["text", "prompt", "value", "string", "content", "caption", "instruction"]);
const NON_TEXT_INPUT_NAMES = new Set([
  "filename_prefix",
  "image",
  "images",
  "mask",
  "api_key",
  "api_base_url",
  "api_token",
  "base_url",
  "token",
  "password",
  "secret",
  "filename",
  "url",
  "path",
  "file",
  "filepath",
  "model",
  "clip_name",
  "vae_name",
  "lora_name",
  "ckpt_name",
  "unet_name",
  "sampler_name",
  "scheduler",
  "format",
  "codec",
  "frame_rate",
  "aspect_ratio",
  "upscale_method",
  "device",
  "weight_dtype",
  "control_after_generate",
  "upload",
  "prefix",
  "output_dir",
  "type",
]);

// 一个节点可能有多个字符串输入；只把“可读写的文本”暴露给自由卡片，
// 模型名/文件名/采样器等技术字段不当作提示词。
function isTextInput(node, name, objectInfo) {
  if (typeof node?.inputs?.[name] !== "string") return false;
  if (NON_TEXT_INPUT_NAMES.has(name)) return false;
  if (name === "text" || name === "prompt") return true;
  const spec = inputSpecs(objectInfo, node.class_type).find((item) => item.name === name);
  if (TEXTISH_INPUT_NAMES.has(name)) return !spec || spec.type === "STRING";
  return spec?.type === "STRING";
}

function firstTextInput(node, objectInfo) {
  for (const name of ["text", "prompt", "value", "string", "content", "caption", "instruction"]) {
    if (isTextInput(node, name, objectInfo)) return name;
  }
  return null;
}

export function convertUiWorkflow(ui, objectInfo = {}) { return convertSavedWorkflow(ui, objectInfo); }

function listNodes(workflow) {
  return Object.entries(workflow || {});
}

function linkTarget(value) {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === "string" ? String(value[0]) : null;
}

function reachableNodes(workflow, roots) {
  const all = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (!id || all.has(id)) continue;
    const node = workflow[id];
    if (!node) continue;
    all.add(id);
    for (const value of Object.values(node.inputs || {})) {
      const target = linkTarget(value);
      if (target) stack.push(target);
    }
  }
  return all;
}

// ComfyUI 会校验提交上来的每一个节点；游离节点（没连到任何输出）照样会被校验，
// 里面引用了缺失的模型/节点就会让整次生成失败。执行前只保留输出节点能到达的子图。
export function pruneUnreachableNodes(workflow) {
  const entries = listNodes(workflow);
  if (!entries.length) return workflow || {};
  const roots = entries
    .filter(([, node]) => /save|preview|output|combine/i.test(String(node?.class_type || "")))
    .map(([id]) => id);
  if (!roots.length) return workflow;
  // 多个输出互不相连时（例如工作流里残留的保存节点），只保留能回溯到最多节点的那条链路；
  // 否则那条游离的 SaveImage 仍会被 ComfyUI 执行并因缺模型/缺输入而失败。
  let best = null;
  for (const root of roots) {
    const reachable = reachableNodes(workflow, [root]);
    if (!best || reachable.size > best.size) best = reachable;
  }
  if (!best || best.size === entries.length) return workflow;
  const next = {};
  for (const [id, node] of entries) {
    if (best.has(id)) next[id] = node;
  }
  return next;
}

function numericInput(node, name) {
  const value = node?.inputs?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function detectFreeBindings(workflow, objectInfo = {}) {
  const entries = listNodes(workflow);
  const outputs = entries.filter(([, node]) => isImageOutputClass(node.class_type) || isVideoOutputClass(node.class_type));
  const outputType = outputs.some(([, node]) => isVideoOutputClass(node.class_type)) ? "video" : outputs.some(([, node]) => isImageOutputClass(node.class_type)) ? "image" : null;
  const roots = outputs.length ? outputs.map(([id]) => id) : entries.map(([id]) => id);
  const reachable = reachableNodes(workflow, roots);
  const warnings = [];
  if (!outputType) warnings.push("没有找到 SaveImage / SaveVideo 输出节点");

  const samplers = entries.filter(([id, node]) => reachable.has(id) && (node.inputs?.positive !== undefined || /KSampler|SamplerCustom|SelfLift/i.test(node.class_type)));
  const positiveReach = reachableNodes(
    workflow,
    samplers.map(([, node]) => linkTarget(node.inputs?.positive)).filter(Boolean),
  );
  const negativeReach = reachableNodes(
    workflow,
    samplers.map(([, node]) => linkTarget(node.inputs?.negative)).filter(Boolean),
  );

  // 暴露所有可写文本输入；正/负极性只用于排序和默认主提示词，不再单独猜一个。
  const textInputs = [];
  for (const [id, node] of entries) {
    if (!reachable.has(id)) continue;
    for (const input of Object.keys(node.inputs || {})) {
      if (!isTextInput(node, input, objectInfo)) continue;
      const role =
        positiveReach.has(id) && !negativeReach.has(id)
          ? "positive"
          : negativeReach.has(id) && !positiveReach.has(id)
            ? "negative"
            : positiveReach.has(id) && negativeReach.has(id)
              ? "shared"
              : "unknown";
      textInputs.push({
        node: id,
        input,
        title: String(node._meta?.title || "").trim(),
        default: String(node.inputs[input]),
        role,
      });
    }
  }
  const roleRank = { positive: 0, unknown: 1, shared: 1, negative: 2 };
  textInputs.sort((a, b) => (roleRank[a.role] ?? 1) - (roleRank[b.role] ?? 1) || Number(a.node) - Number(b.node) || a.input.localeCompare(b.input));
  const titleCounts = new Map();
  for (const item of textInputs) if (item.title) titleCounts.set(item.title, (titleCounts.get(item.title) || 0) + 1);
  textInputs.forEach((item, index) => {
    const base = item.title || `文本框 ${index + 1}`;
    item.label = item.title && titleCounts.get(item.title) > 1 ? `${base} · #${item.node}` : base;
  });

  let prompt = null;
  const promptCandidates = [];
  const queue = samplers
    .map(([id, node]) => ({ target: linkTarget(node.inputs?.positive), distance: 0, from: id }))
    .filter((item) => item.target);
  const seen = new Set();
  while (queue.length) {
    const item = queue.shift();
    if (!item.target || seen.has(item.target)) continue;
    seen.add(item.target);
    const node = workflow[item.target];
    if (!node) continue;
    const textName = firstTextInput(node, objectInfo);
    if (textName) {
      promptCandidates.push({ node: item.target, input: textName, distance: item.distance, title: node._meta?.title || node.class_type });
      continue;
    }
    for (const value of Object.values(node.inputs || {})) {
      const target = linkTarget(value);
      if (target) queue.push({ target, distance: item.distance + 1, from: item.target });
    }
  }
  if (!promptCandidates.length) {
    for (const [id, node] of entries) {
      if (!reachable.has(id)) continue;
      // 只从 negative 可达、且不从 positive 可达的节点不能当正向提示词。
      if (negativeReach.has(id) && !positiveReach.has(id)) continue;
      const textName = firstTextInput(node, objectInfo);
      if (textName) promptCandidates.push({ node: id, input: textName, distance: 99, title: node._meta?.title || node.class_type });
    }
  }
  promptCandidates.sort((a, b) => a.distance - b.distance || Number(a.node) - Number(b.node));
  if (promptCandidates.length) {
    prompt = { node: promptCandidates[0].node, input: promptCandidates[0].input };
  } else if (textInputs.length) {
    const fallback = textInputs.find((item) => item.role === "positive") || textInputs.find((item) => item.role !== "negative") || textInputs[0];
    prompt = { node: fallback.node, input: fallback.input };
    warnings.push("没有找到明确的正向提示词链，已默认使用第一个文本框。");
  } else {
    warnings.push("没有找到可写的文本输入，卡片将不显示提示词框");
  }
  if (textInputs.length > 1) {
    const primary = textInputs.find((item) => prompt && item.node === prompt.node && item.input === prompt.input);
    warnings.push(`检测到 ${textInputs.length} 个文本输入，已全部显示；默认主提示词为「${primary?.label || textInputs[0].label}」。`);
  }

  const images = entries
    .filter(([id, node]) => reachable.has(id) && /^LoadImage/.test(node.class_type) && typeof node.inputs?.image === "string")
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, node]) => ({ node: id, input: "image", title: node._meta?.title || node.class_type }));

  const sizes = entries
    .filter(([id, node]) => reachable.has(id) && numericInput(node, "width") !== null && numericInput(node, "height") !== null)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, node]) => ({ node: id, widthInput: "width", heightInput: "height", width: numericInput(node, "width"), height: numericInput(node, "height") }));
  if (sizes.length > 1) warnings.push(`检测到 ${sizes.length} 个尺寸节点，修改尺寸时会同时写入；默认取节点 ${sizes[0].node} 的值。`);

  const ratios = entries
    .filter(([id, node]) => reachable.has(id) && typeof node.inputs?.aspect_ratio === "string")
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, node]) => {
      const options = comboOptions(objectInfo, node.class_type, "aspect_ratio");
      const values = options.length ? options : [node.inputs.aspect_ratio];
      return {
        node: id,
        input: "aspect_ratio",
        value: node.inputs.aspect_ratio,
        options,
        ratios: [...new Set(values.map(canonicalAspectRatio).filter(Boolean))],
      };
    })
    .filter((binding) => binding.ratios.length);

  const batches = entries
    .filter(([id, node]) => reachable.has(id) && numericInput(node, "batch_size") !== null)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, node]) => ({ node: id, input: "batch_size", default: numericInput(node, "batch_size") }));

  const seeds = entries
    .filter(([id, node]) => reachable.has(id) && (numericInput(node, "seed") !== null || numericInput(node, "noise_seed") !== null))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, node]) => {
      const input = numericInput(node, "seed") !== null ? "seed" : "noise_seed";
      return { node: id, input, default: numericInput(node, input) };
    });
  if (seeds.length > 1) warnings.push(`检测到 ${seeds.length} 个种子节点，固定种子会同时写入。`);

  return {
    outputType,
    prompt,
    textInputs,
    images,
    sizes,
    ratios,
    batches,
    seeds,
    warnings,
  };
}

export function bindingSummary(bindings) {
  const ratioBindings = bindings.ratios || [];
  const aspectRatios = [...new Set(ratioBindings.flatMap((binding) => binding.ratios || []))];
  const aspectRatio = canonicalAspectRatio(ratioBindings[0]?.value) || aspectRatios[0] || null;
  return {
    outputType: bindings.outputType || null,
    prompt: Boolean(bindings.prompt),
    textInputs: (bindings.textInputs || []).map((item) => ({
      node: String(item.node),
      input: String(item.input),
      label: String(item.label || item.title || "文本框"),
      default: String(item.default ?? ""),
      role: String(item.role || "unknown"),
    })),
    imageInputs: bindings.images?.length || 0,
    size: bindings.sizes?.[0] ? { width: bindings.sizes[0].width, height: bindings.sizes[0].height } : null,
    aspectRatio,
    aspectRatios,
    count: bindings.batches?.[0]?.default ?? null,
    hasSeed: Boolean(bindings.seeds?.length),
    seed: Number(bindings.seeds?.[0]?.default) > 0 ? String(bindings.seeds[0].default) : null,
    warnings: bindings.warnings || [],
  };
}
