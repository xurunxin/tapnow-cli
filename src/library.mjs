import { z } from 'zod';
import { hash, validate } from './workflow.mjs';
import { TapnowError } from './errors.mjs';
const base = '/api/library/v1';
export const space = name => { if (!['private', 'team'].includes(name)) throw new TapnowError('INVALID_SPACE', 'Use private or team'); return name === 'team' ? 'SPACE_TYPE_TEAM' : 'SPACE_TYPE_PRIVATE'; };
const enc = value => encodeURIComponent(value);
export const AssetSchema = z.object({ asset_type: z.enum(['image', 'video', 'audio', 'text']), name: z.string().min(1), source_url: z.url().optional(), content: z.string().optional(), thumbnail_url: z.url().optional(),
  width: z.number().positive().optional(), height: z.number().positive().optional(), duration_ms: z.number().positive().optional(), file_format: z.string().optional(), file_size: z.number().nonnegative().optional() }).strict();
const Member = z.object({ assetId: z.string().min(1).optional(), sourceAssetId: z.string().min(1).optional(), sortOrder: z.number().int().nonnegative().default(0) }).strict().refine(v => !!v.assetId !== !!v.sourceAssetId, 'Use sourceAssetId for library assets or assetId for existing role members, exclusively');
export const RoleSchema = z.object({ name: z.string().min(1), description: z.string().default(''), members: z.array(Member).min(1), idempotencyKey: z.string().min(1), space: z.enum(['private', 'team']).default('private') }).strict();
export class Library {
  constructor(client) { this.client = client; }
  folders(value = 'private') { return this.client.request('GET', `${base}/spaces/${space(value)}/folders`); }
  createFolder(name, value = 'private', parent = '0') { if (!name.trim()) throw new Error('Folder name required'); return this.client.request('POST', `${base}/folders`, { spaceType: space(value), parentId: parent, name }); }
  assets(folder, page = 1) { return this.client.request('GET', `${base}/folders/${enc(folder)}/assets?page=${page}&page_size=50`); }
  search(keyword, value = 'private', page = 1) { return this.client.request('GET', `${base}/assets:search?` + new URLSearchParams({ keyword, space_type: space(value), page, page_size: 50 })); }
  async asset(id) { const data = await this.client.request('GET', `${base}/assets/${enc(id)}`); if (!data.asset) throw new Error('Unexpected library asset response'); return data.asset; }
  save(folder, input) {
    const a = AssetSchema.parse(input);
    if (a.asset_type !== 'text' && !a.source_url?.startsWith('https://')) throw new Error('Media asset requires an HTTPS source_url');
    if (a.asset_type === 'text' && !a.content?.trim()) throw new Error('Text asset requires content');
    return this.client.request('POST', `${base}/assets:batchCreate`, { folderId: folder, assets: [{ ...a, asset_type: { image: 1, video: 2, audio: 3, text: 4 }[a.asset_type] }] });
  }
  roles(value = 'private', page = 1) { return this.client.request('GET', `${base}/elements?` + new URLSearchParams({ space_type: space(value), page, page_size: 50 })); }
  role(id) { return this.client.request('GET', `${base}/elements/${enc(id)}`); }
  createRole(input) {
    const r = RoleSchema.parse(input);
    if (r.members.some(m => m.assetId)) throw new TapnowError('INVALID_ROLE_MEMBER', 'New roles require sourceAssetId; assetId is only for reusing members during update');
    return this.client.request('POST', `${base}/elements`, { spaceType: space(r.space), name: r.name, description: r.description, members: r.members, idempotencyKey: r.idempotencyKey });
  }
  async updateRole(id, input, revision) {
    const r = RoleSchema.omit({ idempotencyKey: true, space: true }).parse(input);
    if (typeof revision !== 'string' || !revision.trim()) throw new Error('Exact expected revision from roles get is required');
    try { return await this.client.request('PUT', `${base}/elements/${enc(id)}`, { ...r, expectedRevision: revision }); }
    catch (e) { if (e.code === 2005) throw new TapnowError('ROLE_CONFLICT', 'Role changed; fetch the latest revision and reconcile before updating', { id, expectedRevision: revision }, [`tapnow roles get ${id}`]); throw e; }
  }
}
function typeOf(asset) {
  return { 1: 'image', 2: 'video', 3: 'audio', 4: 'text', ASSET_TYPE_IMAGE: 'image', ASSET_TYPE_VIDEO: 'video', ASSET_TYPE_AUDIO: 'audio', ASSET_TYPE_TEXT: 'text' }[asset.asset_type];
}
export function attachAssets(input, targetId, assets, { mode, role } = {}) {
  const plan = structuredClone(input), target = plan.nodes.find(n => n.id === targetId);
  if (!target || target.src || target.type === 'text') throw new TapnowError('INVALID_TARGET', 'Select a generation image/video node');
  plan.links ||= [];
  if (mode) target.mode = mode;
  const add = node => {
    const existing = plan.nodes.find(n => n.id === node.id);
    if (existing && hash(existing.provenance) !== hash(node.provenance)) throw new TapnowError('SOURCE_CHANGED', 'Materialized asset changed; use a new manifest version');
    if (!existing) plan.nodes.push(node);
    if (!plan.links.some(l => l.from === node.id && l.to === targetId)) plan.links.push({ from: node.id, to: targetId });
  };
  if (role) add({ id: 'role-' + hash([role.id, role.revision]).slice(0, 24), type: 'text', title: role.name, prompt: role.description || role.name, provenance: { elementId: role.id, revision: role.revision } });
  for (const a of assets) {
    const type = typeOf(a), provenance = { assetId: a.id, revision: a.updated_at || a.revision || null, sourceUrl: a.source_url || null };
    if (!type) throw new TapnowError('UNSUPPORTED_ASSET', 'Only image/video/audio/text assets can be attached');
    target.provenance ||= {};
    target.provenance.libraryReferences ||= [];
    if (!target.provenance.libraryReferences.some(r => hash(r) === hash(provenance))) target.provenance.libraryReferences.push(provenance);
    if (type === 'audio') { target.audios ||= []; if (!target.audios.includes(a.source_url)) target.audios.push(a.source_url); continue; }
    add({ id: 'asset-' + hash([a.id, provenance]).slice(0, 24), type, title: a.name, prompt: type === 'text' ? a.content : '', ...(type !== 'text' ? { src: a.source_url } : {}), provenance });
  }
  return validate(plan);
}
export function roleSnapshot(value) {
  if (!value.element_id || !value.revision || !Array.isArray(value.assets)) throw new TapnowError('INVALID_ROLE_RESPONSE', 'Cannot pin role revision and assets');
  return { id: value.element_id, revision: value.revision, name: value.name, description: value.description,
    assets: value.assets.map(a => ({ ...a, id: a.asset_id, revision: value.revision })) };
}
