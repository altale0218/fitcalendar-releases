import { readFile } from 'node:fs/promises';
import { manifestFor, publishRepository } from './publish.mjs';

const repo = 'altale0218/fitcalendar-releases';
const branch = 'main';
const origin = new URL('https://fitcalendar-updates.pages.dev/');
const githubCatalog = new URL('https://raw.githubusercontent.com/' + repo + '/' + branch + '/update/');
const apkMaxBytes = 25 * 1024 * 1024;

async function download(url) {
  const response = await fetch(url, {
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw Error(url.host + ' HTTP ' + response.status);
  return response;
}

async function main() {
  const request = JSON.parse(await readFile('update/mirror-request.json', 'utf8'));
  const { channel, versionCode, sha256 } = request;
  if (!['stable', 'beta'].includes(channel) || !Number.isSafeInteger(versionCode) ||
      versionCode < 1 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw Error('Invalid mirror request');
  }

  const catalog = await (await download(new URL(channel + '.json', origin))).json();
  const filename = 'fitcalendar-' + channel + '-' + versionCode + '-' + sha256.slice(0, 16) + '.apk';
  const source = new URL(filename, origin);
  if (catalog.schema !== 1 || catalog.packageName !== 'com.fitcalendar.app' ||
      catalog.channel !== channel || catalog.versionCode !== versionCode || catalog.sha256 !== sha256 ||
      catalog.url !== source.href || !Number.isSafeInteger(catalog.bytes) ||
      catalog.bytes < 1 || catalog.bytes > apkMaxBytes) {
    throw Error('Cloudflare catalog does not match the authorized mirror request');
  }

  const response = await download(source);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > catalog.bytes) throw Error('Cloudflare APK is larger than the authorized catalog');
    chunks.push(chunk);
  }
  const apk = Buffer.concat(chunks, length);
  const payload = manifestFor(channel, catalog.version, versionCode, apk, catalog.notes);
  if (payload.bytes !== catalog.bytes || payload.sha256 !== sha256) {
    throw Error('Cloudflare APK differs from the authorized catalog');
  }
  await publishRepository('github', { repo, branch }, githubCatalog, payload, apk, filename);
  console.log('GitHub release asset and catalog verified');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
