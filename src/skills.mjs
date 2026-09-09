import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { TapnowError } from './errors.mjs';

const root = fileURLToPath(new URL('../skills/', import.meta.url));
export const skillNames = ['tapnow-workflow', 'tapnow-image', 'tapnow-video'];
export async function listSkills() {
  return Promise.all(skillNames.map(async name => ({ name, description: (await fs.readFile(join(root, name, 'SKILL.md'), 'utf8')).match(/^description: (.+)$/m)?.[1] })));
}
function checked(name) { if (!skillNames.includes(name)) throw new TapnowError('SKILL_NOT_FOUND', `Unknown skill ${name}`, { allowed: skillNames }); return name; }
export async function showSkill(name) { return { name: checked(name), content: await fs.readFile(join(root, name, 'SKILL.md'), 'utf8') }; }
async function files(directory, prefix = '') {
  const result = {};
  for (const entry of await fs.readdir(join(directory, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new TapnowError('SKILL_CONFLICT', 'Skill contains a symbolic link', { path: join(directory, rel) });
    if (entry.isDirectory()) Object.assign(result, await files(directory, rel));
    else if (entry.name !== '.tapnow-install.json') result[rel] = createHash('sha256').update(await fs.readFile(join(directory, rel))).digest('hex');
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export async function installSkills(names, options = {}) {
  const selected = names.includes('all') ? skillNames : [...new Set(names.map(checked))];
  names.forEach(n => { if (n !== 'all') checked(n); });
  if (!['codex', 'claude', 'agents'].includes(options.agent || 'codex')) throw new TapnowError('INVALID_AGENT', 'Use codex, claude, or agents');
  const agent = options.agent || 'codex';
  const base = options.global ? (agent === 'codex' ? process.env.CODEX_HOME || join(homedir(), '.codex') : join(homedir(), agent === 'claude' ? '.claude' : '.agents')) : join(options.cwd || process.cwd(), agent === 'claude' ? '.claude' : '.agents');
  const directory = resolve(options.dir || join(base, 'skills'));
  const planned = [];
  for (const name of selected) {
    const source = join(root, name), destination = join(directory, name), digest = await files(source);
    let exists = false;
    try { const stat = await fs.lstat(destination); exists = true; if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TapnowError('SKILL_CONFLICT', 'Destination is not a regular directory', { destination }); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (exists) {
      const actual = await files(destination);
      if (JSON.stringify(actual) === JSON.stringify(digest)) { planned.push({ name, destination, status: 'unchanged' }); continue; }
      // Preserve local modifications and unrelated skills. Install a new version into an empty directory.
      throw new TapnowError('SKILL_CONFLICT', 'Existing skill differs; preserve it and choose an empty --dir for the new version', { name, destination }, ['Compare skills show with the installed SKILL.md before replacing it manually.']);
    }
    planned.push({ name, destination, source, digest, status: options.dryRun ? 'planned' : 'installed' });
  }
  if (!options.dryRun) {
    await fs.mkdir(directory, { recursive: true });
    for (const item of planned.filter(p => p.source)) {
      await fs.mkdir(item.destination); // Exclusive ownership; another install cannot overwrite it.
      for (const relative of Object.keys(item.digest)) {
        const destination = join(item.destination, relative);
        await fs.mkdir(dirname(destination), { recursive: true });
        await fs.copyFile(join(item.source, relative), destination, fs.constants.COPYFILE_EXCL);
      }
      await fs.writeFile(join(item.destination, '.tapnow-install.json'), JSON.stringify({ version: 1, name: item.name, files: item.digest }, null, 2));
    }
  }
  return { directory, skills: planned.map(({ source, digest, ...entry }) => entry), next: ['Reload your agent session to discover the installed skills.'] };
}
