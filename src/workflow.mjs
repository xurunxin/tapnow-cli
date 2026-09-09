import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { frontendParams, modelFor, generationBody, estimate } from './models.mjs';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const media = z.array(z.url().refine(s => s.startsWith('https://'), 'Use an HTTPS asset URL'));
const Node = z.object({
  id, type: z.enum(['text', 'image', 'video']), title: z.string().optional(), prompt: z.string().default(''),
  model: z.string().optional(), mode: z.string().optional(), params: z.record(z.string(), z.unknown()).default({}),
  request: z.record(z.string(), z.unknown()).optional(), times: z.number().int().min(1).max(8).default(1),
  src: z.url().optional(), images: media.optional(), videos: media.optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
}).strict();
export const Schema = z.object({
  version: z.literal(1), project: z.object({ key: id, name: z.string().min(1), description: z.string().default(''),
    id: z.string().optional(), orgId: z.string().optional(), team: z.boolean().default(false) }).strict(),
  nodes: z.array(Node).min(1), links: z.array(z.object({ from: id, to: id }).strict()).default([]),
}).strict();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function validate(input) {
  const plan = Schema.parse(input), ids = new Set();
  for (const n of plan.nodes) {
    if (ids.has(n.id)) throw new Error(`Duplicate node ${n.id}`);
    ids.add(n.id);
    if (n.type !== 'text' && !n.src) {
      if (!n.model) throw new Error(`${n.id}: model is required`);
      const incoming = plan.links.filter(l => l.to === n.id).map(l => plan.nodes.find(p => p.id === l.from));
      frontendParams(n, { images: incoming.filter(p => p?.type === 'image').map(() => 'https://example.invalid/reference') });
    }
    for (const key of ['metadata', 'context', 'prompt', 'times']) if (n.request && key in n.request) throw new Error(`${n.id}: request may not override ${key}`);
    for (const key of ['model', 'provider', 'prompt', 'times', 'images', 'videos', 'modelType']) if (key in n.params) throw new Error(`${n.id}: set ${key} at node level, not params`);
  }
  const links = new Set();
  for (const l of plan.links) {
    if (!ids.has(l.from) || !ids.has(l.to)) throw new Error(`Dangling link ${l.from} -> ${l.to}`);
    const key = `${l.from}:${l.to}`;
    if (links.has(key)) throw new Error(`Duplicate link ${key}`);
    links.add(key);
  }
  order(plan);
  return plan;
}
export function order(plan) {
  const result = [], seen = new Set(), active = new Set();
  const visit = n => {
    if (active.has(n.id)) throw new Error(`Workflow contains a cycle at ${n.id}`);
    if (seen.has(n.id)) return;
    active.add(n.id);
    for (const l of plan.links.filter(l => l.to === n.id)) visit(plan.nodes.find(p => p.id === l.from));
    active.delete(n.id); seen.add(n.id); result.push(n);
  };
  plan.nodes.forEach(visit); return result;
}
export async function readPlan(file) { return validate(JSON.parse(await fs.readFile(file, 'utf8'))); }
export async function withState(file, plan, fn) {
  let lock;
  try { lock = await fs.open(file + '.lock', 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`Workflow locked: ${file}.lock (remove only after checking no process is running)`); throw e; }
  try {
    await lock.writeFile(String(process.pid));
    let state;
    try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; state = { version: 1, projectKey: plan.project.key, namespace: randomUUID(), nodes: {}, jobs: {}, reservedCost: 0 }; }
    if (state.projectKey !== plan.project.key) throw new Error('State belongs to another project');
    const save = async () => { const temp = file + '.tmp'; await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temp, file); };
    return await fn(state, save);
  } finally { await lock.close(); await fs.unlink(file + '.lock'); }
}
const canvasPath = canvasId => '/api/canvas/v1/canvases/' + encodeURIComponent(canvasId);
export async function getCanvas(client, id) {
  const data = await client.request('GET', canvasPath(id) + '?with_nodes=true&with_connections=true');
  return data.canvas ?? data;
}
async function batch(client, canvasId, kind, actions) {
  if (actions.length) await client.request('POST', canvasPath(canvasId) + `/${kind}:batchActions`, { canvas_id: canvasId, actions, created_by_role: 'user' });
}
function config(data) { return { prompt: data.prompt, title: data.title, params: data.params, type: data.type }; }
export async function apply(client, plan, state, save) {
  if (Object.keys(state.jobs).length && state.planHash !== hash(plan)) throw new Error('A submitted run is immutable. Create a new workflow/state for changed requirements.');
  const identity = await client.identity();
  if (plan.project.orgId && identity.orgId !== plan.project.orgId) throw new Error('Workflow orgId differs from selected organization');
  if (state.orgId && state.orgId !== identity.orgId) throw new Error('State belongs to a different organization');
  state.orgId = identity.orgId;
  if (state.canvasId && plan.project.id && state.canvasId !== plan.project.id) throw new Error('Project id differs from recorded state');
  state.canvasId ||= plan.project.id;
  if (!state.canvasId) {
    if (state.creating) throw new Error('Previous project creation outcome is unknown. Find the project with projects list and set project.id before continuing.');
    state.creating = true; await save();
    const data = await client.request('POST', '/api/canvas/v1/canvases', { name: plan.project.name, description: plan.project.description, is_public: false, is_shared_with_org: plan.project.team });
    state.canvasId = data.canvas?.id || data.id;
    if (!state.canvasId) throw new Error('Project creation returned no ID; inspect projects list before retrying');
    state.creating = false; await save();
  }
  const canvas = await getCanvas(client, state.canvasId);
  if (canvas.org_id && canvas.org_id !== identity.orgId) throw new Error('Canvas is in another organization');
  const creates = [], updates = [];
  const sorted = order(plan);
  for (const [index, n] of sorted.entries()) {
    state.nodes[n.id] ||= `${n.type}-${hash([state.namespace, n.id]).slice(0, 32)}`;
    const nodeId = state.nodes[n.id], existing = canvas.nodes.find(r => r.id === nodeId);
    let params = {};
    if (n.type !== 'text' && !n.src) {
      const parentImages = plan.links.filter(l => l.to === n.id && plan.nodes.find(p => p.id === l.from)?.type === 'image').map(() => 'https://example.invalid/reference');
      const p = frontendParams(n, { images: parentImages });
      const { prompt, images, videos, times, ...rest } = p;
      params = { ...rest, provider: modelFor(n.type, n.model).provider, ...(n.times > 1 ? { times: n.times } : {}) };
    }
    const data = { ...existing?.data, src: existing?.data?.src || n.src || '', prompt: n.prompt, title: n.title || n.id,
      type: n.src ? 'upload' : 'generate', params,
      ...(n.type === 'text' ? { text: n.prompt, content: n.prompt } : {}) };
    const next = { id: nodeId, canvas_id: state.canvasId, type: n.type, position: n.position || { x: 100 + index * 400, y: 200 }, data };
    if (existing) {
      const baseline = state.configs?.[n.id];
      if (baseline && hash(config(existing.data)) !== baseline && hash(config(existing.data)) !== hash(config(data))) throw new Error(`${n.id}: canvas was edited outside CLI; export/reconcile before applying`);
      if (hash(config(existing.data)) !== hash(config(data)) || hash(existing.position) !== hash(next.position)) updates.push({ id: nodeId, data, position: next.position });
    } else creates.push(next);
  }
  await save(); // Stable IDs survive partial writes.
  await batch(client, state.canvasId, 'nodes', [...(creates.length ? [{ action: 'create', creates }] : []), ...(updates.length ? [{ action: 'update', updates }] : [])]);
  const links = plan.links.map(l => ({ id: 'link-' + hash([state.namespace, l.from, l.to]).slice(0, 32), canvas_id: state.canvasId,
    source: state.nodes[l.from], target: state.nodes[l.to], source_handle: 'right', target_handle: 'left', type: 'default', deletable: true, selectable: true }));
  const newLinks = links.filter(l => !canvas.connections.some(c => c.id === l.id));
  await batch(client, state.canvasId, 'connections', newLinks.length ? [{ action: 'create', creates: newLinks }] : []);
  if (canvas.name !== plan.project.name || canvas.description !== plan.project.description || canvas.is_shared_with_org !== plan.project.team) {
    await client.request('PATCH', canvasPath(state.canvasId), { name: plan.project.name, description: plan.project.description, is_shared_with_org: plan.project.team });
  }
  const verified = await getCanvas(client, state.canvasId);
  for (const n of plan.nodes) {
    const actual = verified.nodes.find(r => r.id === state.nodes[n.id]);
    if (!actual) throw new Error(`Node ${n.id} missing after save`);
    state.configs ||= {}; state.configs[n.id] = hash(config(actual.data));
  }
  for (const l of links) if (!verified.connections.some(c => c.id === l.id && c.source === l.source && c.target === l.target)) throw new Error('Link readback failed');
  state.planHash = hash(plan); await save();
  return { canvasId: state.canvasId, url: `https://app.tapnow.ai/canvas/${state.canvasId}`, created: creates.length, updated: updates.length, linked: newLinks.length };
}
export function taskOutputs(task, type) {
  const generated = type === 'image' ? task.generated_images?.map(v => v.image_url) : task.generated_videos?.map(v => v.video_url);
  const outputs = Array.isArray(task.outputs) ? task.outputs : (type === 'image' ? task.outputs?.image_urls : task.outputs?.video_urls);
  return [...new Set([...(generated || []), ...(outputs || [])].filter(u => typeof u === 'string' && u.startsWith('https://')))];
}
export async function getTasks(client, ids) {
  if (!ids.length || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))) throw new Error('Invalid task IDs');
  const qs = new URLSearchParams({ ids: ids.join(',') });
  const data = await client.request('GET', '/api/conversation/v1/generations/tasks?' + qs);
  if (!Array.isArray(data)) throw new Error('Unexpected task status response');
  return data;
}
export function inputsFor(plan, node, state) {
  const inputs = { images: [], videos: [], texts: [] };
  for (const l of plan.links.filter(l => l.to === node.id)) {
    const parent = plan.nodes.find(n => n.id === l.from);
    if (parent.type === 'text') { inputs.texts.push(parent.prompt); continue; }
    const src = parent.src || state.jobs[parent.id]?.outputs?.[0];
    if (!src) throw new Error(`${node.id} waits for ${parent.id} output`);
    inputs[parent.type === 'image' ? 'images' : 'videos'].push(src);
  }
  return inputs;
}
export async function run(client, plan, state, save, options) {
  if (state.planHash !== hash(plan)) throw new Error('Workflow differs from synchronized canvas; run workflow apply first');
  if (!options.execute) throw new Error('Generation requires --execute and --max-cost');
  if (!Number.isFinite(options.maxCost) || options.maxCost < 0) throw new Error('A nonnegative --max-cost is required');
  if ((state.reservedCost || 0) > options.maxCost) throw new Error('Recorded cost already exceeds --max-cost');
  const identity = await client.identity();
  if (state.orgId !== identity.orgId) throw new Error('Workflow organization differs from active account');
  const before = await getCanvas(client, state.canvasId);
  for (const n of plan.nodes) {
    const remote = before.nodes.find(r => r.id === state.nodes[n.id]);
    if (!remote || (state.configs?.[n.id] && hash(config(remote.data)) !== state.configs[n.id])) throw new Error(`${n.id}: canvas changed since apply; inspect before generating`);
  }
  const deadline = Date.now() + options.timeout * 1000;
  for (const node of order(plan)) {
    if (node.type === 'text' || node.src) continue;
    let job = state.jobs[node.id];
    if (job?.status === 'submitting' || job?.status === 'unknown') throw new Error(`${node.id}: submission outcome unknown; inspect generation history and use jobs attach. No automatic retry.`);
    if (job?.status === 'failed') throw new Error(`${node.id}: previous generation failed; inspect jobs before creating a new run`);
    if (!job) {
      const inputs = inputsFor(plan, node, state);
      const body = await generationBody(client, { ...node, prompt: [...inputs.texts, node.prompt].filter(Boolean).join('\n\n') }, inputs, state.canvasId, state.nodes[node.id]);
      const { cost, quote } = await estimate(client, node.type, body);
      if (state.reservedCost + cost > options.maxCost) throw new Error(`${node.id}: estimated total ${state.reservedCost + cost} exceeds --max-cost ${options.maxCost}`);
      options.log?.({ node: node.id, estimatedCost: cost, service: quote.serviceName });
      job = state.jobs[node.id] = { status: 'submitting', cost, startedAt: new Date().toISOString() };
      state.reservedCost += cost; await save();
      const response = await client.request('POST', '/api/conversation/v1/generations/' + node.type, body);
      job.ids = response.result?.ids;
      if (!Array.isArray(job.ids) || !job.ids.length) { job.status = 'unknown'; await save(); throw new Error('Submission returned no task IDs; inspect history before retrying'); }
      job.status = 'pending'; await save();
      options.log?.({ node: node.id, taskIds: job.ids });
    }
    while (job.status !== 'completed') {
      if (Date.now() >= deadline) throw new Error('Wait timed out; rerun the same command to resume without resubmitting');
      const tasks = await getTasks(client, job.ids);
      if (job.ids.some(id => !tasks.some(t => t.id === id))) throw new Error('Task status missing; rerun to resume');
      if (tasks.some(t => ['failed', 'cancelled', 'canceled'].includes(t.status))) { job.status = 'failed'; await save(); throw new Error(`${node.id}: generation failed; inspect jobs status`); }
      if (tasks.every(t => t.status === 'completed')) {
        job.outputs = tasks.flatMap(t => taskOutputs(t, node.type));
        if (!job.outputs.length) throw new Error(`${node.id}: completed task has no output URLs`);
        job.status = 'completed'; await save();
      } else await new Promise(resolve => setTimeout(resolve, options.interval * 1000));
    }
    // Reconcile output even when resuming after the remote task completed.
    const canvas = await getCanvas(client, state.canvasId);
    const remote = canvas.nodes.find(n => n.id === state.nodes[node.id]);
    if (!remote) throw new Error(`${node.id}: remote node disappeared`);
    await batch(client, state.canvasId, 'nodes', [{ action: 'update', updates: [{ id: remote.id,
      data: { ...remote.data, src: job.outputs[0], taskInfo: { taskId: job.ids[0], status: 'completed', injectType: 'src' } } }] }]);
    options.log?.({ node: node.id, status: 'completed', outputs: job.outputs });
  }
  return { canvasId: state.canvasId, estimatedCostReserved: state.reservedCost, jobs: state.jobs };
}
