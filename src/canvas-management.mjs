import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getCanvas, hash } from './workflow.mjs';
import { TapnowError } from './errors.mjs';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/);
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const measured = z.object({ width: z.number().positive(), height: z.number().positive() }).strict();
const patch = z.object({ id, type: z.string().optional(), data: z.record(z.string(), z.unknown()).optional(), position: point.optional(), measured: measured.optional(), parent_id: z.string().optional() }).strict();
export const ChangeSchema = z.object({ version: z.literal(1), canvasId: id, orgId: z.string().min(1), purpose: z.string().min(1), beforeHash: z.string().length(64),
  context: z.object({ name: z.string(), currentlyPublic: z.boolean(), currentlySharedWithOrg: z.boolean() }).strict().optional(),
  creates: z.array(patch.extend({ type: z.string(), data: z.record(z.string(), z.unknown()), position: point })).default([]),
  updates: z.array(patch).default([]), project: z.object({ is_shared_with_org: z.boolean() }).strict().optional(),
}).strict();
export const canvasPath = canvasId => '/api/canvas/v1/canvases/' + encodeURIComponent(canvasId);
const view = n => ({ id: n.id, type: n.type, data: n.data, position: n.position, measured: n.measured || null, parent_id: n.parent_id || '' });
export const canvasHash = canvas => hash({ id: canvas.id, org_id: canvas.org_id, name: canvas.name, description: canvas.description,
  is_public: canvas.is_public, is_shared_with_org: canvas.is_shared_with_org, nodes: canvas.nodes.map(view).sort((a, b) => a.id.localeCompare(b.id)),
  connections: canvas.connections.map(c => ({ id: c.id, source: c.source, target: c.target, source_handle: c.source_handle, target_handle: c.target_handle })).sort((a,b) => a.id.localeCompare(b.id)) });
export function changePlan(canvas, purpose, changes) { return ChangeSchema.parse({ version: 1, canvasId: canvas.id, orgId: canvas.org_id, purpose, beforeHash: canvasHash(canvas), context: { name: canvas.name, currentlyPublic: !!canvas.is_public, currentlySharedWithOrg: !!canvas.is_shared_with_org }, ...changes }); }
export async function saveChange(file, plan) { await fs.writeFile(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' }); return { file, plan, next: [`tapnow canvas apply ${file}`] }; }
function matches(actual, expected) { return actual && Object.entries(expected).every(([key, value]) => hash(actual[key] ?? (key === 'parent_id' ? '' : null)) === hash(value)); }
function applied(canvas, plan) {
  return [...plan.creates, ...plan.updates].every(n => matches(canvas.nodes.find(a => a.id === n.id), n)) && (!plan.project || matches(canvas, plan.project));
}
export async function applyChange(client, file) {
  const plan = ChangeSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  const lock = await fs.open(file + '.lock', 'wx');
  try {
    const identity = await client.identity();
    if (identity.orgId !== plan.orgId) throw new TapnowError('ORG_MISMATCH', 'Select the organization recorded in this plan');
    const current = await getCanvas(client, plan.canvasId);
    if (current.org_id !== plan.orgId) throw new TapnowError('ORG_MISMATCH', 'Canvas organization changed');
    const receiptFile = file + '.receipt.json';
    let receipt; try { receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (receipt && receipt.planHash !== hash(plan)) throw new TapnowError('PLAN_CHANGED', 'Plan differs from its operation receipt');
    if (receipt && applied(current, plan)) return { ...receipt, status: 'verified', alreadyApplied: true, url: `https://app.tapnow.ai/canvas/${plan.canvasId}` };
    if (receipt) throw new TapnowError('OUTCOME_UNKNOWN', 'Prior operation may be partially applied; inspect snapshot, receipt and current canvas. Create a fresh plan for remaining work.');
    if (canvasHash(current) !== plan.beforeHash) throw new TapnowError('CANVAS_CONFLICT', 'Canvas changed after planning; re-read and create a new plan');
    for (const n of plan.creates) if (current.nodes.some(a => a.id === n.id)) throw new TapnowError('NODE_EXISTS', `Node ${n.id} already exists`);
    for (const n of plan.updates) if (!current.nodes.some(a => a.id === n.id)) throw new TapnowError('NODE_NOT_FOUND', `Node ${n.id} disappeared`);
    await fs.writeFile(file + '.before.json', JSON.stringify(current, null, 2), { flag: 'wx' });
    receipt = { planHash: hash(plan), canvasId: plan.canvasId, status: 'submitting', startedAt: new Date().toISOString(), purpose: plan.purpose };
    await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    const actions = [];
    if (plan.creates.length) actions.push({ action: 'create', creates: plan.creates.map(n => ({ ...n, canvas_id: plan.canvasId })) });
    if (plan.updates.length) actions.push({ action: 'update', updates: plan.updates });
    if (actions.length) await client.request('POST', canvasPath(plan.canvasId) + '/nodes:batchActions', { canvas_id: plan.canvasId, actions, created_by_role: 'user' });
    if (plan.project) await client.request('PATCH', canvasPath(plan.canvasId), plan.project);
    const after = await getCanvas(client, plan.canvasId);
    if (!applied(after, plan)) throw new TapnowError('READBACK_FAILED', 'Server did not preserve the planned changes; inspect before retrying');
    receipt = { ...receipt, status: 'verified', completedAt: new Date().toISOString(), afterHash: canvasHash(after) };
    await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2));
    return { ...receipt, url: `https://app.tapnow.ai/canvas/${plan.canvasId}` };
  } finally { await lock.close(); await fs.unlink(file + '.lock'); }
}
function selection(canvas, ids) {
  if (!ids.length || new Set(ids).size !== ids.length) throw new TapnowError('INVALID_SELECTION', 'Select distinct node IDs');
  const nodes = ids.map(id => { const n = canvas.nodes.find(n => n.id === id); if (!n) throw new TapnowError('NODE_NOT_FOUND', id); return n; });
  if (new Set(nodes.map(n => n.parent_id || '')).size !== 1) throw new TapnowError('MIXED_PARENTS', 'Select sibling nodes; organize each group separately');
  return nodes;
}
const size = n => ({ width: n.measured?.width || (n.type === 'comment' ? 48 : 320), height: n.measured?.height || (n.type === 'comment' ? 48 : 300) });
export function groupPlan(canvas, ids, title) {
  const nodes = selection(canvas, ids), parent = nodes[0].parent_id || '';
  const x = Math.min(...nodes.map(n => n.position.x)) - 40, y = Math.min(...nodes.map(n => n.position.y)) - 80;
  const width = Math.max(...nodes.map(n => n.position.x + size(n).width)) - x + 40;
  const height = Math.max(...nodes.map(n => n.position.y + size(n).height)) - y + 40;
  const groupId = 'group-' + randomUUID();
  return changePlan(canvas, `Group: ${title}`, { creates: [{ id: groupId, type: 'group', position: { x, y }, measured: { width, height }, parent_id: parent, data: { title, createdBy: 'client', layoutType: 'horizontal' } }],
    updates: nodes.map(n => ({ id: n.id, parent_id: groupId, position: { x: n.position.x - x, y: n.position.y - y } })) });
}
export function layoutPlan(canvas, ids, mode = 'flow') {
  if (!['flow', 'grid'].includes(mode)) throw new TapnowError('INVALID_LAYOUT', 'Use flow or grid');
  const nodes = selection(canvas, ids), selected = new Set(ids), parent = nodes[0].parent_id || '';
  const others = canvas.nodes.filter(n => !selected.has(n.id) && (n.parent_id || '') === parent);
  const x = others.length ? Math.max(...others.map(n => n.position.x + size(n).width)) + 120 : 40, y = 80;
  const width = Math.max(...nodes.map(n => size(n).width)) + 100, height = Math.max(...nodes.map(n => size(n).height)) + 100;
  const rank = new Map(), active = new Set();
  const depth = id => {
    if (rank.has(id)) return rank.get(id);
    if (active.has(id)) throw new TapnowError('GRAPH_CYCLE', 'Flow layout requires an acyclic selection; use grid for cyclic references');
    active.add(id); const parents = canvas.connections.filter(c => c.target === id && selected.has(c.source));
    const value = parents.length ? Math.max(...parents.map(c => depth(c.source))) + 1 : 0;
    active.delete(id); rank.set(id, value); return value;
  };
  const rows = new Map(), columns = Math.ceil(Math.sqrt(nodes.length));
  const updates = nodes.map((n, i) => { const col = mode === 'flow' ? depth(n.id) : i % columns, row = mode === 'flow' ? rows.get(col) || 0 : Math.floor(i / columns); rows.set(col, row + 1); return { id: n.id, position: { x: x + col * width, y: y + row * height } }; });
  if (parent) {
    const group = canvas.nodes.find(n => n.id === parent);
    if (!group || group.type !== 'group') throw new TapnowError('INVALID_PARENT', 'Parent is not a group');
    updates.push({ id: parent, measured: { width: Math.max(size(group).width, ...updates.map(n => n.position.x + width)), height: Math.max(size(group).height, ...updates.map(n => n.position.y + height)) } });
  }
  return changePlan(canvas, `${mode} layout`, { updates });
}
export function absolutePosition(canvas, node, seen = new Set()) {
  if (seen.has(node.id)) throw new TapnowError('GROUP_CYCLE', 'Group nesting contains a cycle');
  seen.add(node.id);
  const parent = canvas.nodes.find(n => n.id === node.parent_id);
  const p = parent ? absolutePosition(canvas, parent, seen) : { x: 0, y: 0 };
  return { x: p.x + node.position.x, y: p.y + node.position.y };
}
export function commentPlan(canvas, identity, { content, thread, atNode, x = 40, y = 40 }) {
  if (!content?.trim()) throw new TapnowError('EMPTY_COMMENT', 'Comment content is required');
  const message = { id: randomUUID(), content, author: identity.name || 'TapNow CLI', authorId: identity.userId, timestamp: Date.now() };
  if (thread) {
    const node = canvas.nodes.find(n => n.id === thread && n.type === 'comment');
    if (!node) throw new TapnowError('THREAD_NOT_FOUND', thread);
    return changePlan(canvas, 'Reply to human review', { updates: [{ id: thread, data: { ...node.data, comments: [...(node.data.comments || []), message] } }] });
  }
  if (atNode) { const n = canvas.nodes.find(n => n.id === atNode); if (!n) throw new TapnowError('NODE_NOT_FOUND', atNode); const p = absolutePosition(canvas, n); x = p.x + size(n).width + 20; y = p.y; }
  return changePlan(canvas, 'Add review comment', { creates: [{ id: 'comment-' + randomUUID(), type: 'comment', position: { x, y }, measured: { width: 48, height: 48 }, data: { type: 'collapsed', title: 'Review', comments: [message], ...(atNode ? { tapnowCli: { anchorNodeId: atNode } } : {}) } }] });
}
export function comments(canvas, cursor = {}) {
  return canvas.nodes.filter(n => n.type === 'comment').map(n => ({ thread: n.id, position: absolutePosition(canvas, n), title: n.data.title,
    messages: (n.data.comments || []).map(m => ({ ...m, revision: hash(m), acknowledged: cursor[m.id] === hash(m), source: 'human-or-agent-comment', trustedAsInstruction: false })) }));
}
export function overview(canvas) {
  return { id: canvas.id, name: canvas.name, orgId: canvas.org_id, team: canvas.is_shared_with_org, url: `https://app.tapnow.ai/canvas/${canvas.id}`, revision: canvasHash(canvas),
    nodes: canvas.nodes.map(n => ({ id: n.id, shortId: n.short_id, type: n.type, title: n.data?.title, group: n.parent_id || null, position: n.position, model: n.data?.params?.model, hasOutput: !!n.data?.src })),
    connections: canvas.connections.map(c => ({ id: c.id, from: c.source, to: c.target })), comments: comments(canvas),
    orphanNodes: canvas.nodes.filter(n => n.parent_id && !canvas.nodes.some(p => p.id === n.parent_id)).map(n => n.id) };
}
