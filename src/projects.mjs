import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { validate, hash, config, getCanvas } from './workflow.mjs';
import { TapnowError } from './errors.mjs';

export function checkout(canvas) {
  const raw = canvas.nodes.filter(n => ['text', 'image', 'video'].includes(n.type));
  if (!raw.length) throw new TapnowError('NO_SUPPORTED_NODES', 'No text/image/video nodes to adopt; append a workflow with project.id instead');
  const mappings = Object.fromEntries(raw.map((n, i) => [n.id, `n${i + 1}`]));
  const nodes = raw.map(n => {
    const data = n.data || {}, params = { ...data.params };
    if (data.loading || (!data.src && data.taskInfo)) throw new TapnowError('PENDING_REMOTE_JOB', `Inspect/recover existing task for ${n.id} before checkout; no duplicate submission will be created`);
    const node = { id: mappings[n.id], type: n.type, title: data.title || n.id, prompt: data.text ?? data.prompt ?? '', provenance: { canvasId: canvas.id, nodeId: n.id, importedAt: new Date().toISOString() } };
    if (n.type !== 'text' && data.src) node.src = data.src;
    else if (n.type !== 'text') {
      node.model = params.model; node.mode = params.modelType;
      node.times = Number(params.times) || 1;
      for (const k of ['model', 'modelType', 'provider', 'times', 'variant']) delete params[k];
      node.params = params;
    }
    return node;
  });
  // Completed media are immutable input anchors; their old generation inputs remain in the canvas snapshot.
  const active = new Set(nodes.filter(n => !n.src).map(n => n.id));
  const links = canvas.connections.filter(c => mappings[c.source] && active.has(mappings[c.target])).map(c => ({ from: mappings[c.source], to: mappings[c.target] }));
  const unique = [...new Map(links.map(l => [`${l.from}:${l.to}`, l])).values()];
  const plan = validate({ version: 1, project: { key: 'existing-' + canvas.id, id: canvas.id, name: canvas.name, description: canvas.description || '', orgId: canvas.org_id, team: !!canvas.is_shared_with_org }, nodes, links: unique });
  const state = { version: 1, namespace: randomUUID(), projectKey: plan.project.key, canvasId: canvas.id, orgId: canvas.org_id, planHash: hash(plan), jobs: {}, reservedCost: 0,
    nodes: Object.fromEntries(raw.map(n => [mappings[n.id], n.id])), configs: Object.fromEntries(raw.map(n => [mappings[n.id], hash(config(n.data))])) };
  return { plan, state, excluded: canvas.nodes.filter(n => !mappings[n.id]).map(n => ({ id: n.id, type: n.type })), note: 'Existing outputs are input anchors. Groups/comments/unsupported nodes remain on the canvas. Add new generation nodes for revisions.' };
}
export async function checkoutFile(client, canvasId, file) {
  const canvas = await getCanvas(client, canvasId), result = checkout(canvas);
  const files = [file, file + '.tapnow-state.json', file + '.canvas.json'];
  // Reserve all outputs before writing any to avoid replacing a previous local workflow.
  const handles = [];
  let writing = false;
  try {
    for (const path of files) handles.push(await fs.open(path, 'wx'));
    writing = true;
    for (const [i, value] of [result.plan, result.state, canvas].entries()) await handles[i].writeFile(JSON.stringify(value, null, 2) + '\n');
  } catch (e) {
    if (!writing) { for (const h of handles) await h.close(); for (const path of files.slice(0, handles.length)) await fs.unlink(path); handles.length = 0; }
    throw e;
  } finally { for (const h of handles) await h.close(); }
  return { files, ...result, next: ['Add new nodes or configure unfinished nodes, then workflow apply/estimate/run.'] };
}
export async function openProject(client, id, browser) {
  const canvas = await getCanvas(client, id), url = `https://app.tapnow.ai/canvas/${encodeURIComponent(canvas.id)}`;
  if (browser) {
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    await new Promise((resolve, reject) => { const child = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
  }
  return { id: canvas.id, name: canvas.name, url, browserRequested: !!browser, next: [`tapnow projects checkout ${canvas.id} workflow.json`] };
}
