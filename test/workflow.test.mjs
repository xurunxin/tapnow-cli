import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate, order, hash, run, withState, apply, taskOutputs, getTasks } from '../src/workflow.mjs';
import { frontendParams, estimate, estimateBody } from '../src/models.mjs';
import { unwrap } from '../src/client.mjs';
import { storageUrl } from '../src/assets.mjs';

const minimal = () => validate({ version: 1, project: { key: 'test', name: 'Test' }, nodes: [{ id: 'img', type: 'image', model: 'nano-banana-flash', prompt: 'Cube' }] });
const fake = () => {
  const calls = [], canvas = { id: 'canvas', org_id: 'org', name: 'Test', description: '', is_shared_with_org: false, nodes: [], connections: [] };
  const client = { calls, canvas, identity: async () => ({ userId: 'user', orgId: 'org' }), request: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/api/billing/v2/estimate') return { tapiesCost: '5', serviceName: 'Test quote' };
    if (path === '/api/conversation/v1/generations/image') return { result: { ids: ['task'] } };
    if (path.includes('/generations/tasks?')) return [{ id: 'task', status: 'completed', outputs: ['https://files.tapnow.media/result.png'] }];
    if (path.endsWith('batchActions')) {
      const target = path.includes('/nodes:') ? canvas.nodes : canvas.connections;
      for (const action of body.actions) {
        for (const n of action.creates || []) target.push(structuredClone(n));
        for (const n of action.updates || []) Object.assign(target.find(t => t.id === n.id), structuredClone(n));
      }
      return {};
    }
    if (path.startsWith('/api/canvas/')) return { canvas: structuredClone(canvas) };
    throw new Error('Unexpected request ' + path);
  } };
  return client;
};
const initial = plan => ({ version: 1, namespace: 'namespace', projectKey: plan.project.key, canvasId: 'canvas', orgId: 'org', nodes: {}, jobs: {}, reservedCost: 0 });
const opts = { execute: true, maxCost: 10, timeout: 1, interval: 0.001 };
test('canonical hash tolerates server JSON key ordering', () => {
  assert.equal(hash({ a: 1, b: { c: 2, d: 3 } }), hash({ b: { d: 3, c: 2 }, a: 1 }));
});
test('reject duplicate, dangling and cyclic graphs', () => {
  const p = minimal(); p.nodes.push(p.nodes[0]); assert.throws(() => validate(p), /Duplicate/);
  const q = minimal(); q.links.push({ from: 'missing', to: 'img' }); assert.throws(() => validate(q), /Dangling/);
  const r = minimal(); r.links.push({ from: 'img', to: 'img' }); assert.throws(() => validate(r), /cycle/);
});
test('topological order ignores manifest order', () => {
  const p = minimal(); p.nodes.push({ id: 'brief', type: 'text', prompt: 'Brief' }); p.links.push({ from: 'brief', to: 'img' });
  assert.deepEqual(order(p).map(n => n.id), ['brief', 'img']);
});
test('model enums and modes reject incompatible input', () => {
  assert.throws(() => frontendParams({ id: 'x', type: 'image', model: 'nano-banana-flash', params: { imageSize: '99K' } }), /imageSize/);
  assert.throws(() => frontendParams({ id: 'x', type: 'video', model: 'veo3.1-lite', mode: 'reference_to_video' }), /does not support/);
});
test('API errors in successful HTTP envelopes fail', () => {
  assert.throws(() => unwrap(200, { code: 403, request_id: 'trace' }), e => e.requestId === 'trace');
  assert.throws(() => unwrap(401, { code: 0 }), /HTTP 401/);
});
test('billing never accepts missing or nonfinite cost', async () => {
  for (const tapiesCost of [undefined, '', 'NaN', '-1', 'Infinity']) await assert.rejects(estimate({ request: async () => ({ tapiesCost }) }, 'image', {}), /trustworthy/);
});
test('budget exhausted prevents generation POST', async () => {
  const p = minimal(), c = fake(), state = initial(p);
  await apply(c, p, state, async () => {});
  await assert.rejects(run(c, p, state, async () => {}, { ...opts, maxCost: 4 }), /exceeds/);
  assert.equal(c.calls.filter(c => c.path === '/api/conversation/v1/generations/image').length, 0);
});
test('no execution flag means no API request', async () => {
  const p = minimal(), c = fake(), state = initial(p); state.planHash = hash(p);
  await assert.rejects(run(c, p, state, async () => {}, { ...opts, execute: false }), /requires/);
  assert.equal(c.calls.length, 0);
});
test('resume completed jobs reconciles output without spending twice', async () => {
  const p = minimal(), c = fake(), state = initial(p); await apply(c, p, state, async () => {});
  await run(c, p, state, async () => {}, opts); await run(c, p, state, async () => {}, opts);
  assert.equal(c.calls.filter(c => c.path === '/api/conversation/v1/generations/image').length, 1);
  assert.equal(state.reservedCost, 5);
  assert.equal(c.canvas.nodes[0].data.src, 'https://files.tapnow.media/result.png');
});
test('ambiguous submission cannot resubmit', async () => {
  const p = minimal(), c = fake(), state = initial(p); await apply(c, p, state, async () => {}); state.jobs.img = { status: 'submitting' }; c.calls.length = 0;
  await assert.rejects(run(c, p, state, async () => {}, opts), /outcome unknown/);
  assert.equal(c.calls.filter(c => c.method !== 'GET').length, 0);
});
test('network timeout preserves submitting journal and budget reservation', async () => {
  const p = minimal(), c = fake(), state = initial(p); await apply(c, p, state, async () => {});
  const original = c.request; c.request = async (method, path, body) => { if (path.endsWith('/generations/image')) throw new Error('network timeout'); return original(method, path, body); };
  await assert.rejects(run(c, p, state, async () => {}, opts), /network timeout/);
  assert.equal(state.jobs.img.status, 'submitting'); assert.equal(state.reservedCost, 5);
});
test('apply preserves external nodes and generated output', async () => {
  const p = minimal(), c = fake(), state = initial(p); c.canvas.nodes.push({ id: 'unrelated', data: { src: 'keep' } });
  await apply(c, p, state, async () => {}); c.canvas.nodes[1].data.src = 'https://files.tapnow.media/result.png';
  await apply(c, p, state, async () => {});
  assert.equal(c.canvas.nodes.length, 2); assert.equal(c.canvas.nodes[1].data.src, 'https://files.tapnow.media/result.png');
});
test('applying an unchanged plan performs no writes', async () => {
  const p = minimal(), c = fake(), state = initial(p); await apply(c, p, state, async () => {}); c.calls.length = 0;
  const result = await apply(c, p, state, async () => {});
  assert.equal(result.updated, 0); assert.equal(c.calls.filter(c => c.method !== 'GET').length, 0);
});
test('changed workflow cannot reuse completed task outputs', async () => {
  const p = minimal(), c = fake(), state = initial(p); await apply(c, p, state, async () => {});
  await run(c, p, state, async () => {}, opts); p.nodes[0].prompt = 'Changed';
  await assert.rejects(apply(c, p, state, async () => {}), /immutable/);
});
test('external prompt edits cause a conflict', async () => {
  const p = minimal(), c = fake(), state = initial(p); await apply(c, p, state, async () => {});
  c.canvas.nodes[0].data.prompt = 'User edit'; await assert.rejects(apply(c, p, state, async () => {}), /edited outside CLI/);
});
test('task output extraction supports image and video responses', () => {
  assert.deepEqual(taskOutputs({ outputs: { image_urls: ['https://files.tapnow.media/a'], file_ids: ['a'] } }, 'image'), ['https://files.tapnow.media/a']);
  assert.deepEqual(taskOutputs({ generated_images: [{ image_url: 'https://files.tapnow.media/a' }], outputs: ['https://files.tapnow.media/a'] }, 'image'), ['https://files.tapnow.media/a']);
  assert.deepEqual(taskOutputs({ generated_videos: [{ video_url: 'https://files.tapnow.media/v' }] }, 'video'), ['https://files.tapnow.media/v']);
});
test('task queries use comma-separated IDs as required by the live API', async () => {
  let path;
  await getTasks({ request: async (_, value) => { path = value; return []; } }, ['task1', 'task2']);
  assert.equal(new URL(path, 'https://app.tapnow.ai').searchParams.get('ids'), 'task1,task2');
});
test('download refuses local, credential-bearing and unrelated URLs', () => {
  for (const u of ['http://127.0.0.1/x', 'https://evil.example/x', 'https://a:b@files.tapnow.media/x', 'https://files.tapnow.media.evil.example/x']) assert.throws(() => storageUrl(u));
});
test('exclusive workflow lock prevents parallel submissions', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tapnow-test-')), file = join(directory, 'state.json'), p = minimal();
  try {
    await withState(file, p, async (state, save) => { await save(); await assert.rejects(withState(file, p, () => {}), /locked/); });
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).projectKey, 'test');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
