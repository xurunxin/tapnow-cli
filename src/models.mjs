import fs from 'node:fs/promises';
export let catalog = JSON.parse(await fs.readFile(new URL('../data/models.json', import.meta.url), 'utf8'));
export function useCatalog(value) {
  if (!Array.isArray(value.models) || value.models.some(m => !['image', 'video'].includes(m.type) || typeof m.model !== 'string' || typeof m.provider !== 'string')) throw new Error('Invalid model catalog');
  catalog = value;
}
export function modelFor(type, model) {
  const entry = catalog.models.find(m => m.type === type && m.model === model);
  if (!entry) throw new Error(`Unknown ${type} model ${model}; run models list or models refresh`);
  return entry;
}
export function frontendParams(node, inputs = {}) {
  const m = modelFor(node.type, node.model);
  const images = [...(node.images || []), ...(inputs.images || [])];
  const videos = [...(node.videos || []), ...(inputs.videos || [])];
  const modelType = node.mode || (node.type === 'image' ? (images.length ? 'image_to_image' : 'text_to_image') : (images.length ? 'image_to_video' : 'text_to_video'));
  const variant = m.variants?.find(v => v.modelType === modelType);
  if (m.variants && !variant) throw new Error(`${node.model} does not support ${modelType}`);
  if (m.supportedModes && !m.supportedModes.includes(modelType)) throw new Error(`${node.model} does not support ${modelType}`);
  const p = { ...m.defaults, ...variant?.defaults, ...node.params, model: node.model, modelType, prompt: node.prompt || '', times: node.times || 1, images, videos };
  const options = { ...m.options, ...variant?.options };
  for (const [key, list] of Object.entries({ aspectRatio: options.aspectRatios, imageSize: options.imageSizeOptions, resolution: options.resolutions, duration: options.durations, thinking_level: options.thinkingLevelOptions })) {
    if (list?.length && p[key] !== undefined && !list.includes(p[key])) throw new Error(`${node.id}: ${key}=${p[key]} must be one of ${list.join(', ')}`);
  }
  if (options.maxImages && images.length > options.maxImages) throw new Error(`${node.id}: too many reference images`);
  return p;
}
export async function generationBody(client, node, inputs, canvasId, nodeId) {
  const p = frontendParams(node, inputs);
  let transformed;
  if (node.request) transformed = { ...node.request };
  else if (client.page) transformed = await client.runtime('transform', { type: node.type, model: node.model, params: p });
  else if (['nano-banana-flash', 'tamar-google-gemini-pro', 'nano-banana-flash-lite'].includes(node.model)) {
    transformed = { model: node.model, provider: 'google', image_size: p.imageSize === '512P' ? '0.5K' : p.imageSize,
      ...(p.aspectRatio !== 'Auto' ? { aspect_ratio: p.aspectRatio } : {}),
      ...(p.enableGoogleSearch !== undefined ? { enable_google_search: p.enableGoogleSearch } : {}),
      ...(p.enable_image_search !== undefined ? { enable_image_search: p.enable_image_search } : {}),
      ...(p.thinking_level ? { thinking_level: p.thinking_level } : {}) };
  } else if (['veo3.1-lite', 'veo3.1', 'veo3.1-fast'].includes(node.model)) {
    if (!['text_to_video', 'image_to_video'].includes(p.modelType)) throw new Error('Use browser mode for this video input mode');
    transformed = { model: node.model, provider: 'google', aspect_ratio: p.aspectRatio, duration: p.duration, resolution: p.resolution, generate_audio: p.generateAudio };
  } else throw new Error(`${node.model}: use browser mode or explicit request parameters`);
  const identity = await client.identity();
  return { scene: 'generation', ...transformed, prompt: p.prompt, times: p.times,
    ...(p.images.length && (node.type === 'image' || !client.page) ? { images: [...new Set([...(transformed.images || []), ...p.images])] } : {}),
    ...(p.videos.length && !client.page ? { videos: p.videos } : {}),
    metadata: { canvas_id: canvasId, node_id: nodeId },
    context: { user_id: identity.userId, org_id: identity.orgId, canvas_id: canvasId, node_id: nodeId } };
}
export function estimateBody(type, body) {
  const { context, metadata, prompt, times = 1, provider, model, scene, ...params } = body;
  return { type: type === 'image' ? 'GT_IMAGE' : 'GT_VIDEO', model, provider, usageQuantity: String(times),
    ...(type === 'image' ? { imageParams: { model, ...params } } : { videoParams: { ...params, realModel: model, quality: params.resolution } }) };
}
export async function estimate(client, type, body) {
  const quote = await client.request('POST', '/api/billing/v2/estimate', estimateBody(type, body));
  const cost = Number(quote.tapiesCost);
  if (typeof quote.tapiesCost !== 'string' || !quote.tapiesCost.trim() || !Number.isFinite(cost) || cost < 0) throw new Error('No trustworthy cost estimate; generation refused');
  return { cost, quote };
}
