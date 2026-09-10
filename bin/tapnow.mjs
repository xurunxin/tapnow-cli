#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Client } from '../src/client.mjs';
import { catalog, useCatalog, generationBody, estimate, frontendParams, capabilities, modelFor } from '../src/models.mjs';
import { Schema, readPlan, order, withState, apply, run, getCanvas, getTasks, inputsFor, taskOutputs } from '../src/workflow.mjs';
import { upload, download } from '../src/assets.mjs';
import { configureFile } from '../src/configure.mjs';
import { listSkills, showSkill, installSkills } from '../src/skills.mjs';
import { errorResult } from '../src/errors.mjs';
import { registerManagement } from '../src/management-cli.mjs';
import { ChangeSchema } from '../src/canvas-management.mjs';
import { RoleSchema, AssetSchema } from '../src/library.mjs';

const cli = new Command().name('tapnow').description('TapNow 项目、节点和 AI 生图/生视频工作流 CLI').version('0.3.0')
  .option('--org <id>', '明确指定个人或团队组织 ID')
  .option('--cdp <url>', '连接本机已登录 Chrome CDP')
  .option('--profile <directory>', '独立浏览器用户目录')
  .option('--channel <name>', '浏览器 channel', 'chrome')
  .option('--catalog <file>', '使用 models refresh 导出的模型目录')
  .option('--headed', '显示浏览器')
  .option('--agent', '输出版本化 JSON envelope，适合 agent 集成');
cli.exitOverride();
cli.configureOutput({ writeErr: () => {} });
cli.hook('preAction', async () => { if (cli.opts().catalog) useCatalog(JSON.parse(await fs.readFile(cli.opts().catalog, 'utf8'))); });
const out = data => console.log(JSON.stringify(cli.opts().agent ? { schemaVersion: 1, ok: true, data } : data, null, 2));
const number = s => { const n = Number(s); if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError('Expected a nonnegative number'); return n; };
const positive = s => { const n = number(s); if (n <= 0) throw new InvalidArgumentError('Expected a positive number'); return n; };
async function connected(fn, { login = false, org, session } = {}) {
  const options = cli.opts();
  if (org && options.org && org !== options.org) throw new Error('--org and project.orgId disagree');
  const client = new Client({ ...options, org: org || options.org });
  try { await client.open({ login, session }); return await fn(client); } finally { await client.close(); }
}
const auth = cli.command('auth').description('登录与身份');
auth.command('login').action(() => connected(async c => { out(await c.identity()); }, { login: true }));
auth.command('status').action(() => connected(async c => out(await c.identity())));
auth.command('import').description('从标准输入导入本人会话 JSON 到独立浏览器配置，不回显凭据').action(async () => {
  if (process.stdin.isTTY) throw new Error('Pipe session JSON through stdin; never pass tokens as command arguments');
  let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 65536) throw new Error('Session input too large'); }
  const session = JSON.parse(text);
  if (typeof session.accessToken !== 'string' || !session.accessToken || (session.refreshToken !== undefined && typeof session.refreshToken !== 'string')) throw new Error('Expected accessToken and optional refreshToken/orgId');
  await connected(async c => out(await c.identity()), { session });
});
cli.command('orgs').description('列出可用组织').action(() => connected(async c => out(await c.request('GET', '/api/public/v1/organizations'))));
cli.command('balance').description('查看积分余额').action(() => connected(async c => out(await c.request('GET', '/api/billing/v2/wallet/balance'))));

const projects = cli.command('projects').description('个人/团队画布项目');
projects.command('list').option('--limit <n>', '分页条数', positive, 30).option('--offset <n>', '偏移', number, 0).option('--keyword <text>', '按名称搜索项目').action(o => connected(async c => out(await c.request('GET', '/api/canvas/v1/canvases?' + new URLSearchParams({ limit: o.limit, offset: o.offset, type: 'canvas', sort_by: 'updated_at', sort_order: 'desc', ...(o.keyword ? { keyword: o.keyword } : {}) })))));
projects.command('create <name>').option('--description <text>', '项目需求', '').option('--team', '向当前组织团队共享').action((name, o) => connected(async c => { await c.identity(); out(await c.request('POST', '/api/canvas/v1/canvases', { name, description: o.description, is_public: false, is_shared_with_org: !!o.team })); }));
projects.command('get <id>').action(id => connected(async c => out(await getCanvas(c, id))));
projects.command('rename <id> <name>').action((id, name) => connected(async c => out(await c.request('PATCH', '/api/canvas/v1/canvases/' + encodeURIComponent(id), { name }))));
projects.command('export <id> <file>').action((id, file) => connected(async c => { await fs.writeFile(file, JSON.stringify(await getCanvas(c, id), null, 2) + '\n', { flag: 'wx' }); out({ path: resolve(file) }); }));

const models = cli.command('models').description('模型目录与参数');
models.command('list').option('--type <type>', 'image/video').action(o => out({ observedAt: catalog.observedAt, source: catalog.source, models: catalog.models.filter(m => !o.type || m.type === o.type).map(m => ({ type: m.type, model: m.model, provider: m.provider, hidden: !!m.isHidden, modes: m.supportedModes || m.variants?.map(v => v.modelType) })) }));
models.command('show <model>').action(model => { const result = catalog.models.filter(m => m.model === model); if (!result.length) throw new Error('Model not found'); out(result); });
models.command('params <model>').option('--mode <mode>', '生成模式').description('结构化有效参数、默认值、输入范围和组合约束').action((model, o) => {
  const m = catalog.models.find(m => m.model === model); if (!m) throw new Error('Model not found');
  out({ observedAt: catalog.observedAt, source: catalog.source, ...capabilities(m, o.mode) });
});
models.command('refresh <file>').description('读取当前网页模型目录并导出（不覆盖内置快照）').action(file => connected(async c => { const result = await c.runtime('catalog'); await fs.writeFile(file, JSON.stringify(result, null, 2), { flag: 'wx' }); out({ path: resolve(file), count: result.models.length }); }));

const workflow = cli.command('workflow').description('声明式项目工作流');
const collect = (value, previous) => [...previous, value];
workflow.command('configure <file> <node>').description('校验并预览参数调整；显式保存')
  .option('--model <model>', '切换模型').option('--mode <mode>', '切换模式，auto 按输入判断')
  .option('--reset-params', '清空旧模型参数后使用新默认值').option('--times <n>', '生成数量', positive)
  .option('--set <key=value>', '设置参数，值按 JSON 或字符串解析，可重复', collect, [])
  .option('--unset <key>', '移除参数，可重复', collect, [])
  .option('--write', '保存到原工作流').option('--output <file>', '写到不存在的新文件')
  .action(async (file, node, o) => out(await configureFile(file, node, o)));
workflow.command('init <file>').option('--name <name>', '项目名称', 'My TapNow Project').action(async (file, o) => {
  const example = JSON.parse(await fs.readFile(new URL('../examples/image-to-video.json', import.meta.url), 'utf8'));
  example.project.name = o.name;
  await fs.writeFile(file, JSON.stringify(example, null, 2) + '\n', { flag: 'wx' }); out({ path: resolve(file) });
});
workflow.command('validate <file>').action(async file => { const plan = await readPlan(file); out({ valid: true, project: plan.project.name, order: order(plan).map(n => n.id) }); });
workflow.command('plan <file>').description('离线预览，不创建项目，不生成').action(async file => { const plan = await readPlan(file); out({ project: plan.project, nodes: order(plan).map(n => ({ id: n.id, type: n.type, model: n.model, params: n.params, billable: n.type !== 'text' && !n.src })), links: plan.links }); });
workflow.command('apply <file>').option('--state <file>', '状态文件，默认工作流文件名.tapnow-state.json').action(async (file, o) => {
  const plan = await readPlan(file);
  await connected(c => withState(o.state || file + '.tapnow-state.json', plan, async (state, save) => out(await apply(c, plan, state, save))), { org: plan.project.orgId });
});
workflow.command('estimate <file>').option('--state <file>', '状态文件').action(async (file, o) => {
  const plan = await readPlan(file);
  let state = { jobs: {}, nodes: {} };
  try { state = JSON.parse(await fs.readFile(o.state || file + '.tapnow-state.json', 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await connected(async c => {
    const quotes = [];
    for (const node of order(plan)) {
      if (node.type === 'text' || node.src) continue;
      let inputs;
      try { inputs = inputsFor(plan, node, state); }
      catch (e) { quotes.push({ node: node.id, deferred: true, reason: e.message }); continue; }
      const body = await generationBody(c, { ...node, prompt: [...inputs.texts, node.prompt].filter(Boolean).join('\n\n') }, inputs, state.canvasId, state.nodes[node.id]);
      quotes.push({ node: node.id, ...await estimate(c, node.type, body) });
    }
    out({ quotes, knownTotal: quotes.reduce((sum, q) => sum + (q.cost || 0), 0), complete: !quotes.some(q => q.deferred) });
  }, { org: plan.project.orgId });
});
workflow.command('prepare <file>').option('--state <file>', '状态文件').description('只读解析实际模型请求，不生成、不扣积分').action(async (file, o) => {
  const plan = await readPlan(file);
  let state = { jobs: {}, nodes: {} };
  try { state = JSON.parse(await fs.readFile(o.state || file + '.tapnow-state.json', 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await connected(async c => {
    const nodes = [];
    for (const node of order(plan)) {
      if (node.type === 'text' || node.src) continue;
      let inputs;
      try { inputs = inputsFor(plan, node, state); } catch (e) { nodes.push({ node: node.id, deferred: true, reason: e.message }); continue; }
      const ready = { ...node, prompt: [...inputs.texts, node.prompt].filter(Boolean).join('\n\n') };
      const resolved = frontendParams(ready, inputs), caps = capabilities(modelFor(node.type, node.model), resolved.modelType);
      nodes.push({ node: node.id, resolved, request: await generationBody(c, ready, inputs, state.canvasId, state.nodes[node.id]),
        checks: { suppliedVideoDurations: node.videoDurations || [], referenceVideoDuration: caps.videoDuration,
          measuredVideoDurations: caps.videoDuration && resolved.videos.length ? await c.videoDurations(resolved.videos) : [],
          mediaInspectionRequired: false } });
    }
    out({ nodes, complete: !nodes.some(n => n.deferred), submitted: false });
  }, { org: plan.project.orgId });
});
workflow.command('run <file>').option('--state <file>', '状态文件').option('--execute', '明确提交消耗积分的生成请求')
  .requiredOption('--max-cost <credits>', '整个运行的累计报价上限（含已提交任务）', number)
  .option('--timeout <seconds>', '本次等待上限', positive, 900).option('--interval <seconds>', '轮询间隔', positive, 5)
  .action(async (file, o) => {
    if (!o.execute) throw new Error('Add --execute to authorize billable generation');
    const plan = await readPlan(file);
    await connected(c => withState(o.state || file + '.tapnow-state.json', plan, async (state, save) => out(await run(c, plan, state, save, { ...o, log: info => console.error(JSON.stringify(info)) }))), { org: plan.project.orgId });
  });
const jobs = cli.command('jobs').description('任务状态与中断恢复');
jobs.command('status <ids...>').action(ids => connected(async c => out(await getTasks(c, ids))));
jobs.command('attach <file> <node> <ids...>').option('--state <file>', '状态文件').description('人工核对任务归属后恢复未知提交，不发起新生成').action(async (file, node, ids, o) => {
  const plan = await readPlan(file);
  await connected(c => withState(o.state || file + '.tapnow-state.json', plan, async (state, save) => {
    if (!state.jobs[node] || !['submitting', 'unknown'].includes(state.jobs[node].status)) throw new Error('Only ambiguous submissions may be attached');
    const tasks = await getTasks(c, ids);
    if (tasks.length !== ids.length) throw new Error('Some tasks were not found');
    const definition = plan.nodes.find(n => n.id === node);
    const history = await c.request('GET', '/api/canvas/v1/canvases/' + encodeURIComponent(state.canvasId) + '/nodes/' + encodeURIComponent(state.nodes[node]) + '/generation-history');
    const files = new Set((history.items || []).flatMap(item => (item.resources || []).map(r => r.file_url)));
    for (const task of tasks) {
      const metadata = task.metadata || task.context;
      const outputs = taskOutputs(task, definition.type);
      const ownsMetadata = metadata?.canvas_id === state.canvasId && metadata?.node_id === state.nodes[node];
      const ownsOutputs = task.status === 'completed' && outputs.length && outputs.every(url => files.has(url));
      if (!ownsMetadata && !ownsOutputs) throw new Error('Task ownership could not be verified; use jobs recover for pending tasks');
    }
    Object.assign(state.jobs[node], { ids, status: 'pending' }); await save(); out({ attached: ids, node });
  }), { org: plan.project.orgId });
});
jobs.command('recover <file> <node>').option('--state <file>', '状态文件').description('查询服务端可恢复任务，不提交生成').action(async (file, node, o) => {
  const plan = await readPlan(file);
  await connected(c => withState(o.state || file + '.tapnow-state.json', plan, async (state, save) => {
    if (!state.jobs[node] || !['submitting', 'unknown'].includes(state.jobs[node].status)) throw new Error('Only ambiguous submissions may be recovered');
    const definition = plan.nodes.find(n => n.id === node);
    const data = await c.request('POST', '/api/conversation/v1/generations/tasks/recoverable', { nodeids: [state.nodes[node]], types: [definition.type] });
    const recovered = data.tasks?.[state.nodes[node]];
    const id = recovered?.taskId || recovered?.task_id;
    if (!id) throw new Error('No recoverable task found. For completed tasks, inspect node history and use jobs attach. Do not resubmit blindly.');
    Object.assign(state.jobs[node], { ids: [id], status: 'pending' }); await save(); out({ node, taskId: id });
  }), { org: plan.project.orgId });
});
const assets = cli.command('assets').description('输入素材上传与结果下载');
assets.command('upload <file>').action(file => connected(async c => out(await upload(c, file))));
assets.command('download <url> <file>').action(async (url, file) => out(await download(url, file)));

const skills = cli.command('skills').description('可安装的 TapNow Agent Skills');
skills.command('list').action(async () => out(await listSkills()));
skills.command('show <name>').action(async name => out(await showSkill(name)));
skills.command('install <names...>').description('安装内置技能，名称 all 表示全部；不同内容拒绝覆盖')
  .option('--target <agent>', 'codex / claude / agents', 'codex').option('--global', '安装到用户技能目录')
  .option('--dir <directory>', '明确指定技能父目录').option('--dry-run', '只预览安装路径')
  .action(async (names, o) => out(await installSkills(names, { ...o, agent: o.target })));
cli.command('schema').description('输出 JSON Schema').option('--kind <kind>', 'workflow / management / role / asset', 'workflow').action(o => {
  const schema = { workflow: Schema, management: ChangeSchema, role: RoleSchema, asset: AssetSchema }[o.kind];
  if (!schema) throw new Error('Unknown schema kind'); out(z.toJSONSchema(schema));
});
cli.command('commands').description('输出可用命令和选项供 agent 发现').action(() => {
  const describe = c => ({ name: c.name(), description: c.description(), arguments: c.registeredArguments.map(a => ({ name: a.name(), required: a.required, variadic: a.variadic })), options: c.options.map(o => ({ flags: o.flags, description: o.description, required: o.mandatory, default: o.defaultValue })), commands: c.commands.map(describe) });
  out(describe(cli));
});

registerManagement({ cli, projects, connected, out, positive });
try { await cli.parseAsync(); }
catch (e) { if (e.exitCode === 0) process.exitCode = 0; else { console.error(JSON.stringify(errorResult(e))); process.exitCode = 1; } }
