import fs from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

export function storageUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['tapnow.media', 'tapnow.ai', 'tapnow.art', 'storage.googleapis.com', 'aliyuncs.com'].some(d => u.hostname === d || u.hostname.endsWith('.' + d))) throw new Error('Expected a TapNow/storage HTTPS URL');
  return u;
}
export async function upload(client, file) {
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }[extname(file).toLowerCase()];
  if (!mime) throw new Error('Supported uploads: PNG/JPEG/WebP/MP4/MOV/MP3/WAV');
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('Upload must be a regular file up to 256 MiB');
  const bytes = await fs.readFile(file);
  const data = await client.request('POST', '/api/conversation/v1/file/upload-url', { file_name: basename(file), mime_type: mime, file_hash: createHash('md5').update(bytes).digest('hex'), file_size: bytes.length, is_temporary: false, is_resumable_uploaded: false });
  if (!data.file_id) throw new Error('Upload initialization returned no file ID');
  if (data.upload_url) {
    const res = await fetch(storageUrl(data.upload_url), { method: 'PUT', body: bytes, headers: { 'Content-Type': mime, 'x-goog-if-generation-match': '0', 'x-oss-forbid-overwrite': 'true', 'cache-control': 'public, max-age=86400' }, redirect: 'error', signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`Storage upload failed: HTTP ${res.status}`);
    await client.request('PUT', '/api/conversation/v1/file/upload-url/' + encodeURIComponent(data.file_id));
  }
  return { fileId: data.file_id, url: 'https://files.tapnow.media/api/conversation/storage/uploads/' + encodeURIComponent(data.file_id), mimeType: mime };
}
export async function download(url, file) {
  const res = await fetch(storageUrl(url), { redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file, { flags: 'wx' }));
  return { path: resolve(file), bytes: (await fs.stat(file)).size };
}
