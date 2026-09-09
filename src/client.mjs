import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ORIGIN = 'https://app.tapnow.ai';
export class TapError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'TapError'; Object.assign(this, details); }
}
export function unwrap(status, body) {
  if (status < 200 || status >= 300 || !body || (body.code !== undefined && ![0, 200].includes(body.code))) {
    throw new TapError(`TapNow request failed (HTTP ${status}, code ${body?.code ?? 'unknown'})`, { status, code: body?.code, requestId: body?.request_id });
  }
  return body.data ?? body;
}

export class Client {
  constructor(options = {}) {
    this.options = options;
    this.token = process.env.TAPNOW_ACCESS_TOKEN;
    this.orgId = options.org || process.env.TAPNOW_ORG_ID;
  }
  async open({ login = false, session } = {}) {
    if (this.token && !login && !session) return this;
    if (session) this.token = undefined;
    if (this.options.cdp || process.env.TAPNOW_CDP) {
      const endpoint = this.options.cdp || process.env.TAPNOW_CDP;
      const u = new URL(endpoint);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('CDP must use a loopback address');
      this.browser = await chromium.connectOverCDP(endpoint);
      this.context = this.browser.contexts()[0];
      this.page = this.context.pages().find(p => p.url().startsWith(ORIGIN + '/'));
      if (!this.page) { this.page = await this.context.newPage(); this.ownPage = true; }
    } else {
      this.context = await chromium.launchPersistentContext(this.options.profile || process.env.TAPNOW_PROFILE || join(homedir(), '.tapnow-cli', 'browser'), {
        channel: this.options.channel || 'chrome', headless: !login && !this.options.headed,
      });
      this.ownContext = true;
      this.page = this.context.pages()[0] || await this.context.newPage();
    }
    if (!this.page.url().startsWith(ORIGIN + '/')) await this.page.goto(ORIGIN + '/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (session) {
      await this.page.evaluate(({ accessToken, refreshToken, orgId }) => {
        if (location.origin !== 'https://app.tapnow.ai') throw new Error('Unexpected browser origin');
        localStorage.setItem('access_token', accessToken);
        if (refreshToken) localStorage.setItem('refresh_token', refreshToken);
        if (orgId) { sessionStorage.setItem('active_org_id', orgId); localStorage.setItem('tapnow_cli_org_id', orgId); }
      }, session);
      await this.page.reload({ waitUntil: 'domcontentloaded' });
    }
    await this.page.waitForFunction(() => !!localStorage.getItem('access_token'), null, { timeout: login ? 300000 : 20000 }).catch(() => { throw new Error('TapNow login required: run tapnow auth login'); });
    if (!this.orgId) this.orgId = await this.page.evaluate(() => sessionStorage.getItem('active_org_id') || localStorage.getItem('tapnow_cli_org_id'));
    return this;
  }
  async request(method, path, body) {
    if (!path.startsWith('/api/') || path.includes('://') || path.includes('..')) throw new Error('Invalid TapNow API path');
    let result;
    if (this.token) {
      const response = await fetch(ORIGIN + path, { method, headers: {
        Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json',
        ...(this.orgId ? { 'X-Org-ID': this.orgId } : {}), 'x-tapnow-origin': 'app.tapnow.ai',
      }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000), redirect: 'error' });
      result = { status: response.status, body: await response.json().catch(() => null) };
    } else {
      result = await this.page.evaluate(async ({ method, path, body, orgId }) => {
        if (location.origin !== 'https://app.tapnow.ai') throw new Error('Unexpected browser origin');
        const headers = { Authorization: 'Bearer ' + localStorage.getItem('access_token'), 'Content-Type': 'application/json', 'x-tapnow-origin': location.hostname };
        const org = orgId || sessionStorage.getItem('active_org_id');
        if (org) headers['X-Org-ID'] = org;
        const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        return { status: res.status, body: await res.json().catch(() => null) };
      }, { method, path, body, orgId: this.orgId });
    }
    // Never retry mutations: a network timeout may happen after a billable submission.
    return unwrap(result.status, result.body);
  }
  async identity() {
    if (!this.user) this.user = await this.request('GET', '/api/public/v1/users/me');
    this.orgId ||= this.user.org_id;
    return { userId: this.user.user_id, orgId: this.orgId };
  }
  async runtime(action, args = {}) {
    if (!this.page) throw new Error('This model needs browser mode for current TapNow parameter conversion; unset TAPNOW_ACCESS_TOKEN or provide explicit request parameters');
    return this.page.evaluate(async ({ action, args }) => {
      if (location.origin !== 'https://app.tapnow.ai') throw new Error('Unexpected browser origin');
      const src = [...document.scripts].map(s => s.src).find(s => s.startsWith('https://fe-assets.tapnow.media/') && /\/assets\/index-.*\.js$/.test(s));
      if (!src) throw new Error('TapNow frontend entry changed; adapter update required');
      const text = await (await fetch(src)).text();
      const match = text.match(/from["'](\.\/vendor-packages-[^"']+\.js)["']/);
      if (!match) throw new Error('TapNow model module changed; adapter update required');
      const module = await import(new URL(match[1], src).href);
      if (action === 'catalog') {
        const images = Object.values(module).find(v => v && typeof v === 'object' && v['nano-banana-flash']?.provider);
        const videos = Object.values(module).find(v => v && typeof v === 'object' && v['veo3.1']?.provider);
        if (!images || !videos) throw new Error('TapNow model catalog changed');
        return { observedAt: new Date().toISOString(), source: location.origin, models: ['image', 'video'].flatMap(type => Object.values(type === 'image' ? images : videos).map(({ icon, ...v }) => ({ type, ...v }))) };
      }
      const marker = args.type === 'image' ? 'Unsupported image model:' : 'Unsupported video model:';
      const transform = Object.values(module).find(v => typeof v === 'function' && v.toString().includes(marker));
      if (!transform) throw new Error('TapNow parameter transformer changed');
      const result = transform(args.model, args.params);
      if (!result.success) throw new Error(result.error || 'Unsupported model parameters');
      return result.params;
    }, { action, args });
  }
  async close() {
    if (this.ownContext) await this.context?.close();
    else { if (this.ownPage) await this.page?.close(); await this.browser?.close(); }
  }
}
