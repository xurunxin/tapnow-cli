import { TapnowError } from './errors.mjs';

const optionFields = { aspectRatio: 'aspectRatios', imageSize: 'imageSizeOptions', resolution: 'resolutions', duration: 'durations', quality: 'qualityOptions', thinking_level: 'thinkingLevelOptions', outputFormat: 'outputFormats' };
const isGpt2 = model => /^gpt-image-2(?:\.|$)/.test(model);
const focused = model => /^gpt-image-|^seedance-|^doubao-seedance-|^MiniMax-H3/.test(model);
export function capabilities(m, mode) {
  const modes = m.supportedModes || m.variants?.map(v => v.modelType) || [];
  if (!mode) mode = modes[0];
  if (!modes.includes(mode)) throw new TapnowError('UNSUPPORTED_MODE', `${m.model} does not support ${mode}`, { model: m.model, mode, allowed: modes }, [`tapnow models params ${m.model}`]);
  const variant = m.variants?.find(v => v.modelType === mode) || {};
  const options = { ...m.options, ...variant.options };
  const defaults = { ...m.defaults, ...variant.defaults };
  const fields = Object.fromEntries(Object.entries(optionFields).filter(([, key]) => options[key]?.length).map(([key, opt]) => [key, { enum: options[opt] }]));
  for (const [key, value] of Object.entries(defaults)) fields[key] ||= { type: typeof value };
  if (['derived_from_reference', 'forbidden'].includes(variant.aspectRatioPolicy)) { delete fields.aspectRatio; delete defaults.aspectRatio; }
  if (isGpt2(m.model)) {
    fields.imageSize = { enum: ['1K', '2K', '4K', 'auto'] };
    fields.targetWidth = fields.targetHeight = { type: 'integer', min: 16, max: 3840, multipleOf: 16 };
  }
  if (['seedance-2.0', 'seedance-2.5'].includes(m.model) && mode === 'text_to_video') fields.enableWebSearch = { type: 'boolean' };
  const ranges = {
    images: variant.referenceImageRange || { min: mode === 'image_to_image' || mode === 'image_to_video' ? 1 : mode === 'start_end_to_video' ? 2 : 0, max: mode === 'image_to_image' ? options.maxImages ?? 16 : mode === 'image_to_video' ? 1 : mode === 'start_end_to_video' ? 2 : 0 },
    videos: variant.referenceVideoRange || { min: 0, max: 0 },
    audios: variant.referenceAudioRange || { min: 0, max: 0 },
  };
  return { model: m.model, type: m.type, mode, modes, defaults, fields, ranges,
    times: options.timesOptions || Array.from({ length: 8 }, (_, i) => i + 1),
    aspectRatioPolicy: variant.aspectRatioPolicy, videoDuration: variant.referenceVideoDurationRange,
    audioRequiresCompanion: !!variant.referenceAudioRequiresCompanion,
    strictParameters: focused(m.model),
    constraints: isGpt2(m.model) ? ['auto requires both aspectRatio=auto and imageSize=auto', 'Custom targetWidth/targetHeight must be supplied together; maximum area 8294400 pixels; omit explicit aspectRatio/imageSize when using custom dimensions.'] : [],
  };
}
export function validateParameters(node, p, caps, inputs = {}) {
  const fail = (field, value, expected, message) => { throw new TapnowError('INVALID_PARAMETER', `${node.id}: ${message || `${field} has an unsupported value`}`, { node: node.id, model: node.model, mode: p.modelType, field, value, expected }, [`tapnow models params ${node.model} --mode ${p.modelType}`, 'Use workflow configure to adjust this node, then workflow validate.']); };
  if (['derived_from_reference', 'forbidden'].includes(caps.aspectRatioPolicy) && node.params?.aspectRatio !== undefined) fail('aspectRatio', p.aspectRatio, caps.aspectRatioPolicy, 'aspectRatio is determined by the reference in this mode; unset it');
  for (const [key, value] of Object.entries(node.params || {})) {
    if (caps.strictParameters && !Object.hasOwn(caps.fields, key)) fail(key, value, Object.keys(caps.fields), `unsupported parameter ${key}; it would be ignored by the model`);
  }
  for (const [key, rule] of Object.entries(caps.fields)) {
    const value = p[key]; if (value === undefined) continue;
    if (rule.enum && !rule.enum.includes(value)) fail(key, value, rule.enum);
    if (rule.type === 'boolean' && typeof value !== 'boolean') fail(key, value, 'boolean');
    if (rule.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) fail(key, value, 'finite number');
    if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.min || value > rule.max || value % rule.multipleOf)) fail(key, value, rule);
  }
  if (!caps.times.includes(p.times)) fail('times', p.times, caps.times);
  for (const key of ['images', 'videos', 'audios']) {
    const count = p[key].length, range = caps.ranges[key];
    if (count < range.min || count > range.max) fail(key, count, range, `${key} count ${count} is outside ${range.min}..${range.max} for ${p.modelType}`);
  }
  if (caps.audioRequiresCompanion && p.audios.length && !p.images.length && !p.videos.length) fail('audios', p.audios.length, 'at least one image or video companion');
  if (['derived_from_reference', 'forbidden'].includes(caps.aspectRatioPolicy)) {
    if (node.params?.aspectRatio !== undefined) fail('aspectRatio', p.aspectRatio, caps.aspectRatioPolicy, 'aspectRatio is determined by the reference in this mode; unset it');
    delete p.aspectRatio;
  }
  if (node.model === 'seedance-2.5' && p.modelType === 'video_edit' && p.duration !== -1) fail('duration', p.duration, -1, 'video_edit preserves source duration; use -1');
  if (isGpt2(node.model)) {
    if (p.targetWidth !== undefined || p.targetHeight !== undefined) {
      if (p.targetWidth === undefined || p.targetHeight === undefined || p.targetWidth * p.targetHeight > 8294400) fail('targetWidth/targetHeight', [p.targetWidth, p.targetHeight], 'both dimensions, area <= 8294400');
      if (node.params?.aspectRatio !== undefined || node.params?.imageSize !== undefined) fail('targetWidth/targetHeight', [p.targetWidth, p.targetHeight], 'omit aspectRatio and imageSize for custom pixels');
    } else if ((p.aspectRatio === 'auto') !== (p.imageSize === 'auto')) fail('imageSize/aspectRatio', [p.imageSize, p.aspectRatio], 'auto/auto or an explicit size and ratio');
  }
  if (/\{\{Asset:/.test(p.prompt)) fail('prompt', undefined, 'Declare assets in images/videos/audios', 'Embedded Asset payloads bypass reference validation; use explicit inputs');
  const durations = [...(node.videoDurations || []), ...(inputs.videoDurations || [])];
  if (caps.videoDuration && p.videos.length) {
    const r = caps.videoDuration;
    if (node.videoDurations?.length && node.videoDurations.length !== (node.videos?.length || 0)) fail('videoDurations', node.videoDurations, 'one duration per direct video URL');
    if (inputs.videoDurations?.length && inputs.videoDurations.length !== (inputs.videos?.length || 0)) fail('videoDurations', inputs.videoDurations, 'one duration per linked video URL');
    if (durations.some(d => !Number.isFinite(d) || d < r.min || d > r.max + (r.maxTolerance || 0))) fail('videoDurations', durations, r);
    if (r.totalMax && durations.reduce((a, b) => a + b, 0) > r.totalMax + (r.maxTolerance || 0)) fail('videoDurations', durations, r);
  }
  return p;
}
