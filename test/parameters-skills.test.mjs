import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { frontendParams, capabilities, modelFor, generationBody, estimateBody } from '../src/models.mjs';
import { configure, configureFile } from '../src/configure.mjs';
import { listSkills, installSkills, skillNames } from '../src/skills.mjs';
import { validate } from '../src/workflow.mjs';

const image = (params = {}, rest = {}) => ({ id: 'image', type: 'image', model: 'gpt-image-2', params, ...rest });
const video = (params = {}, rest = {}) => ({ id: 'video', type: 'video', model: 'seedance-2.0', params, ...rest });
const url = 'https://files.tapnow.media/reference.png';
const plan = node => ({ version: 1, project: { key: 'test', name: 'Test' }, nodes: [node], links: [] });
const invalid = fn => assert.throws(fn, e => !!(e.code === 'INVALID_PARAMETER' && e.details.field && e.next.length));

test('GPT Image quality differs by model and unknown API fields are rejected', () => {
  invalid(() => frontendParams(image({ quality: 'max' })));
  assert.equal(frontendParams(image({ quality: 'max' }, { model: 'gpt-image-2.5-flare' })).quality, 'max');
  invalid(() => frontendParams(image({ input_fidelity: 'high' })));
  invalid(() => frontendParams(image({ quality: 'high' }, { model: 'gpt-image-1' })));
});
test('GPT Image auto and custom dimensions cannot silently change', () => {
  invalid(() => frontendParams(image({ aspectRatio: 'auto' })));
  assert.equal(frontendParams(image({ aspectRatio: 'auto', imageSize: 'auto' })).imageSize, 'auto');
  for (const params of [{ targetWidth: 1920 }, { targetWidth: 1921, targetHeight: 1088 }, { targetWidth: 3840, targetHeight: 3840 }, { targetWidth: 1920, targetHeight: 1088, aspectRatio: '16:9' }]) invalid(() => frontendParams(image(params)));
  assert.equal(frontendParams(image({ targetWidth: 1920, targetHeight: 1088 })).targetWidth, 1920);
});
test('image modes validate reference counts and reject unsupported media', () => {
  invalid(() => frontendParams(image({}, { mode: 'image_to_image' })));
  invalid(() => frontendParams(image({}, { mode: 'text_to_image', images: [url] })));
  invalid(() => frontendParams(image({}, { images: Array(17).fill(url) })));
  invalid(() => frontendParams(image({}, { videos: [url] })));
  assert.equal(frontendParams(image({}, { images: [url] })).modelType, 'image_to_image');
});
test('H3 and H3-Max have independent durations, resolutions and modes', () => {
  assert.equal(frontendParams(video({ duration: 4, resolution: '2K' }, { model: 'MiniMax-H3' })).resolution, '2K');
  invalid(() => frontendParams(video({ duration: 4 }, { model: 'MiniMax-H3-Max' })));
  invalid(() => frontendParams(video({ resolution: '2K' }, { model: 'MiniMax-H3-Max' })));
  assert.throws(() => frontendParams(video({}, { model: 'MiniMax-H3-Max', mode: 'start_end_to_video', images: [url, url] })), /does not support/);
  invalid(() => frontendParams(video({ generateAudio: false }, { model: 'MiniMax-H3' })));
});
test('Seedance variants do not silently clamp resolution, count or boolean values', () => {
  for (const model of ['seedance-2.0-fast', 'seedance-2.0-mini']) invalid(() => frontendParams(video({ resolution: '1080p' }, { model })));
  invalid(() => frontendParams(video({}, { times: 3 })));
  invalid(() => frontendParams(video({ generateAudio: 'false' })));
  invalid(() => frontendParams(video({ enableWebSearch: true }, { model: 'seedance-2.0-fast' })));
});
test('auto mode uses video/audio and distinguishes ordered start/end frames', () => {
  assert.equal(frontendParams(video({}, { videos: [url] })).modelType, 'reference_to_video');
  assert.equal(frontendParams(video({}, { audios: [url] })).modelType, 'reference_to_video');
  assert.equal(frontendParams(video({}, { images: [url, url] })).modelType, 'start_end_to_video');
  invalid(() => frontendParams(video({ aspectRatio: '16:9' }, { images: [url] })));
});
test('H3 reference audio requires visual companion and input counts cannot truncate', () => {
  invalid(() => frontendParams(video({}, { model: 'MiniMax-H3', audios: [url] })));
  assert.equal(frontendParams(video({}, { model: 'MiniMax-H3', audios: [url], images: [url] })).audios.length, 1);
  invalid(() => frontendParams(video({}, { model: 'MiniMax-H3', videos: Array(4).fill(url) })));
});
test('reference video duration limits apply to individual and aggregate duration', () => {
  invalid(() => frontendParams(video({}, { model: 'MiniMax-H3', videos: [url], videoDurations: [1] })));
  invalid(() => frontendParams(video({}, { model: 'MiniMax-H3', videos: [url, url], videoDurations: [8, 8] })));
  assert.equal(frontendParams(video({}, { model: 'seedance-2.5', videos: [url], videoDurations: [30.1] })).videos.length, 1);
});
test('Seedance video edit preserves source duration and forbids ratio override', () => {
  const n = video({}, { model: 'seedance-2.5', mode: 'video_edit', videos: [url] });
  assert.equal(frontendParams(n).duration, -1);
  assert.equal(frontendParams(n).aspectRatio, undefined);
  invalid(() => frontendParams({ ...n, params: { duration: 5 } }));
  invalid(() => frontendParams({ ...n, params: { aspectRatio: 'adaptive' } }));
});
test('linked videos take part in offline reference mode validation', () => {
  const p = plan(video({}, { model: 'MiniMax-H3-Max' }));
  p.nodes.push({ id: 'source', type: 'video', src: url }); p.links.push({ from: 'source', to: 'video' });
  assert.throws(() => validate(p), /does not support/);
});
test('generation preserves model-transformed prompt, scene, and audio roles', async () => {
  const c = { page: {}, identity: async () => ({ userId: 'u', orgId: 'o' }), runtime: async () => ({ model: 'agent-video-generation-01', prompt: 'Audio1', audios: [{ url, role: 'reference_audio' }] }) };
  const body = await generationBody(c, video({}, { prompt: '{{Audio 1}}', audios: [url] }), {}, 'canvas', 'node');
  assert.equal(body.prompt, 'Audio1'); assert.equal(body.audios[0].role, 'reference_audio');
  c.runtime = async () => ({ model: 'gpt-image-2', scene: 'image-edit', size: '1024x1024' });
  assert.equal((await generationBody(c, image({}, { images: [url] }), {}, 'canvas', 'node')).scene, 'image-edit');
});
test('live video duration is validated even when manifest claims a valid duration', async () => {
  let transforms = 0;
  const c = { page: {}, videoDurations: async () => [16], runtime: async () => { transforms++; }, identity: async () => ({}) };
  await assert.rejects(generationBody(c, video({}, { model: 'MiniMax-H3', videos: [url], videoDurations: [5] }), {}), /videoDurations/);
  assert.equal(transforms, 0);
});
test('billing normalizes role objects and H3 input aliases into URL arrays', () => {
  assert.deepEqual(estimateBody('video', { model: 'agent-video-generation-01', images: [{ url, role: 'first_frame' }], audios: [{ url, role: 'reference_audio' }] }).videoParams.images, [url]);
  const p = estimateBody('video', { model: 'MiniMax-H3', reference_video_urls: [url], reference_audio_urls: [url], first_frame_image_url: url, last_frame_image_url: url }).videoParams;
  assert.deepEqual(p.videos, [url]); assert.deepEqual(p.audios, [url]); assert.deepEqual(p.images, [url, url]);
});
test('configure switches families only after explicit reset and preserves input file on failure', async t => {
  const original = plan(image({ quality: 'high', imageSize: '2K' }));
  invalid(() => configure(original, 'image', { model: 'gpt-image-1' }));
  const result = configure(original, 'image', { model: 'gpt-image-1', resetParams: true });
  assert.deepEqual(result.after.params, {}); assert.equal(original.nodes[0].model, 'gpt-image-2');
  const dir = await fs.mkdtemp(join(tmpdir(), 'tapnow-config-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'workflow.json'), text = JSON.stringify(original); await fs.writeFile(file, text);
  await assert.rejects(configureFile(file, 'image', { write: true, set: ['quality=wrong'] }));
  assert.equal(await fs.readFile(file, 'utf8'), text);
  await configureFile(file, 'image', { write: true, set: ['quality=low'] });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).nodes[0].params.quality, 'low');
});
test('skills install supports dry run, idempotency, complete references and conflict protection', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'tapnow-skills-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'skills');
  assert.equal((await listSkills()).length, 3);
  assert.equal((await installSkills(['all'], { dir: target, dryRun: true })).skills.length, 3);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const result = await installSkills(['all'], { dir: target }); assert.ok(result.skills.every(s => s.status === 'installed'));
  assert.ok((await installSkills(['all'], { dir: target })).skills.every(s => s.status === 'unchanged'));
  for (const name of skillNames) {
    const content = await fs.readFile(join(target, name, 'SKILL.md'), 'utf8');
    for (const match of content.matchAll(/\]\((references\/[^)]+)\)/g)) assert.ok((await fs.stat(join(target, name, match[1]))).isFile());
  }
  const file = join(target, 'tapnow-image', 'SKILL.md'); await fs.appendFile(file, '\nLocal change');
  await assert.rejects(installSkills(['all'], { dir: target }), { code: 'SKILL_CONFLICT' });
  assert.match(await fs.readFile(file, 'utf8'), /Local change$/);
  await assert.rejects(installSkills(['../outside'], { dir: target }), { code: 'SKILL_NOT_FOUND' });
});
test('agent CLI envelopes, errors, schema and command discovery are machine readable', () => {
  const cli = (...args) => spawnSync(process.execPath, ['bin/tapnow.mjs', ...args], { encoding: 'utf8' });
  for (const args of [['--agent', 'skills', 'list'], ['--agent', 'models', 'params', 'MiniMax-H3'], ['--agent', 'schema'], ['--agent', 'commands']]) {
    const result = cli(...args); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
  const result = cli('workflow', 'configure'); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).ok, false);
  assert.equal(capabilities(modelFor('video', 'MiniMax-H3-Max')).fields.resolution.enum.includes('2K'), false);
});
