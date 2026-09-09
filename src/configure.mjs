import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { validate } from './workflow.mjs';
import { frontendParams } from './models.mjs';
import { TapnowError } from './errors.mjs';

export function planInputs(plan, node) {
  const parents = plan.links.filter(l => l.to === node.id).map(l => plan.nodes.find(n => n.id === l.from));
  return { images: parents.filter(p => p.type === 'image').map(p => p.src || 'https://example.invalid/pending'), videos: parents.filter(p => p.type === 'video').map(p => p.src || 'https://example.invalid/pending') };
}
export function configure(input, nodeId, options = {}) {
  const draft = structuredClone(input), node = draft.nodes.find(n => n.id === nodeId);
  if (!node) throw new TapnowError('NODE_NOT_FOUND', `Node ${nodeId} not found`);
  const before = structuredClone(node);
  if (options.model) node.model = options.model;
  if (options.mode) { if (options.mode === 'auto') delete node.mode; else node.mode = options.mode; }
  if (options.resetParams) node.params = {};
  node.params ||= {};
  if (options.times !== undefined) node.times = Number(options.times);
  for (const key of options.unset || []) delete node.params[key];
  for (const expression of options.set || []) {
    const split = expression.indexOf('=');
    if (split < 1) throw new TapnowError('INVALID_ASSIGNMENT', 'Use --set key=value', { value: expression });
    const key = expression.slice(0, split), raw = expression.slice(split + 1);
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new TapnowError('INVALID_ASSIGNMENT', `Invalid parameter key ${key}`);
    let value; try { value = JSON.parse(raw); } catch { value = raw; }
    node.params[key] = value;
  }
  const plan = validate(draft), after = plan.nodes.find(n => n.id === nodeId);
  return { plan, before, after, resolved: after.type !== 'text' && !after.src ? frontendParams(after, planInputs(plan, after)) : undefined };
}
export async function configureFile(file, nodeId, options) {
  const original = await fs.readFile(file, 'utf8');
  const result = configure(JSON.parse(original), nodeId, options);
  if (options.write && options.output) throw new TapnowError('INVALID_ARGUMENT', 'Choose --write or --output');
  const text = JSON.stringify(result.plan, null, 2) + '\n';
  if (options.output) await fs.writeFile(options.output, text, { flag: 'wx' });
  if (options.write) {
    const lock = await fs.open(file + '.configure.lock', 'wx');
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      if (await fs.readFile(file, 'utf8') !== original) throw new TapnowError('FILE_CHANGED', 'Workflow changed during configuration; inspect and retry');
      await fs.writeFile(temp, text, { flag: 'wx' }); await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }); await lock.close(); await fs.unlink(file + '.configure.lock'); }
  }
  return { ...result, written: options.output || (options.write ? file : null), next: options.write || options.output ? ['workflow validate', 'workflow apply', 'workflow estimate'] : ['Review before/after; add --write or --output to save.'] };
}
