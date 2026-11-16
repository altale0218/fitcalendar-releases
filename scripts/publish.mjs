import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const packageName = 'com.fitcalendar.app';
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const limit = 200 * 1024 * 1024;

function https(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Expected a public HTTPS URL');
  return url.href;
}

async function request(url, options = {}, allowMissing = false) {
  const response = await fetch(https(url), {
    redirect: 'error', signal: AbortSignal.timeout(120000), ...options
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw Error(new URL(url).host + ' HTTP ' + response.status);
  return response;
}

async function anonymous(url, allowMissing = false) {
  // Explicitly check every redirected URL before making the next anonymous request.
  for (let redirects = 0; redirects <= 5; redirects++) {
    url = https(url);
    const response = await fetch(url, {redirect:'manual', cache:'no-store', signal:AbortSignal.timeout(90000)});
    if (allowMissing && response.status === 404) return null;
    if (response.ok) return response;
    const location = response.headers.get('Location');
    if (![301,302,303,307,308].includes(response.status) || !location)
      throw Error(new URL(url).host + ' anonymous HTTP ' + response.status);
    await response.body?.cancel();
    url = new URL(location, url).href;
  }
  throw Error('Public URL redirected too many times');
}

async function verifyAsset(url, manifest) {
  const response = await anonymous(url);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > manifest.bytes) throw Error('Unexpected public APK size');
    hash.update(chunk);
  }
  if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256) throw Error('Public APK does not match manifest');
}

function compatible(previous, next) {
  if (!previous) return;
  if (previous.schema !== 1 || previous.channel !== next.channel || previous.packageName !== packageName ||
      !Number.isSafeInteger(previous.versionCode)) throw Error('Existing catalog is not a FitCalendar catalog');
  if (previous.versionCode > next.versionCode ||
      (previous.versionCode === next.versionCode && previous.sha256 !== next.sha256))
    throw Error('Cannot replace a newer version or reuse a versionCode with different bytes');
}

async function verifyManifest(url, expected) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await anonymous(url,true);
    const got = response && await response.json();
    if (got && Object.keys(expected).every(key => got[key] === expected[key])) return;
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw Error('Public manifest has not converged to the published content');
}

function run(binary, args) {
  const result = spawnSync(binary, args, {encoding:'utf8', windowsHide:true});
  if (result.error || result.status !== 0) throw Error('Command failed: '+binary, {cause:result.error});
  return result.stdout;
}

function validateApk(apk, version, code, signer, channel) {
  const aapt = process.env.AAPT;
  const java = process.env.JAVA_EXECUTABLE || 'java';
  const jar = process.env.APKSIGNER_JAR;
  if (!aapt || !jar) throw Error('Set AAPT and APKSIGNER_JAR');
  const meta = run(aapt,['dump','badging',apk]).match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
  if (!meta || meta[1] !== packageName || Number(meta[2]) !== code || meta[3] !== version) throw Error('APK package/version mismatch');
  const sig = run(java,['-jar',jar,'verify','--print-certs',apk]);
  const hashes = [...sig.matchAll(/certificate SHA-256 digest: ([a-f0-9]{64})/gi)];
  if (hashes.length !== 1 || hashes[0][1].toLowerCase() !== signer?.toLowerCase()) throw Error('APK signer mismatch');
  if (channel === 'stable' && /certificate DN:.*CN=Android Debug/i.test(sig)) throw Error('Stable channel requires a release-signed APK');
}

function manifestFor(channel, version, versionCode, bytes, notes) {
  if (!['stable','beta'].includes(channel) || !/^[0-9][a-zA-Z0-9.+-]{0,39}$/.test(version) ||
      !Number.isSafeInteger(versionCode) || versionCode<1 || versionCode>2100000000 ||
      !bytes.length || bytes.length>limit || notes.length>8000) throw Error('Invalid release metadata');
  return {schema:1, channel, packageName, version, versionCode, notes, bytes:bytes.length, sha256:checksum(bytes)};
}

async function publishRepository(provider, config, base, payload, bytes, filename) {
  const github = provider === 'github';
  const token = process.env[github?'GITHUB_TOKEN':'GITEE_ACCESS_TOKEN'];
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(config.repo) || !config.branch) throw Error(provider+' repository credentials/config missing');
  const repo = (github?'https://api.github.com/repos/':'https://gitee.com/api/v5/repos/') + config.repo;
  const headers = github ? {Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}
    : {Authorization:'Bearer '+token,Accept:'application/json'};
  const api = (path, options = {}, missing = false) => request(repo+path,{...options,headers:{...headers,...options.headers}},missing);
  const send = (path, method, body) => api(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const file = '/contents/update/'+payload.channel+'.json';
  const current = await api(file+'?ref='+encodeURIComponent(config.branch),{},true);
  const currentBody = current ? await current.json() : null;
  // Gitee returns HTTP 200 with [] for a file that does not exist.
  const existing = !github && Array.isArray(currentBody) && currentBody.length === 0 ? null : currentBody;
  if (existing && (!existing.sha || typeof existing.content !== 'string'))
    throw Error('Unexpected '+provider+' catalog file response');
  compatible(existing&&JSON.parse(Buffer.from(existing.content,'base64').toString()),payload);

  const tag = 'fitcalendar-'+payload.channel+'-'+payload.versionCode;
  const found = await api('/releases/tags/'+tag,{},true);
  // Gitee can return HTTP 200 with null for a missing release tag.
  const previousRelease = found ? await found.json() : null;
  const release = previousRelease ?? await (await send('/releases','POST',{
    tag_name:tag,target_commitish:config.branch,name:payload.version,body:payload.notes,
    ...(github?{prerelease:payload.channel==='beta',make_latest:payload.channel==='stable'?'true':'false'}:{prerelease:payload.channel==='beta'})
  })).json();
  const known = (release.assets||[]).find(a=>a.name===filename);
  let asset = known;
  if (!asset && github) {
    const upload = new URL(release.upload_url.split('{')[0]);
    if (upload.origin!=='https://uploads.github.com') throw Error('Unexpected GitHub upload host');
    upload.searchParams.set('name',filename);
    asset = await (await request(upload.href,{method:'POST',headers:{...headers,'Content-Type':'application/vnd.android.package-archive'},body:bytes})).json();
  } else if (!asset) {
    const form = new FormData();
    form.append('file',new Blob([bytes],{type:'application/vnd.android.package-archive'}),filename);
    asset = await (await api('/releases/'+release.id+'/attach_files',{method:'POST',body:form})).json();
  }
  const manifest = {...payload,url:https(asset.browser_download_url)};
  await verifyAsset(manifest.url,manifest);
  const entry = {message:'Publish FitCalendar '+tag,branch:config.branch,content:Buffer.from(json(manifest)).toString('base64'),
    ...(existing?{sha:existing.sha}:{})};
  await send(file,github||existing?'PUT':'POST',entry);
  await verifyManifest(new URL(payload.channel+'.json',base).href,manifest);
}

async function publishPages(config, base, payload, bytes, filename) {
  if (!config.project || !config.branch || !config.directory || !process.env.WRANGLER_JS) throw Error('Pages deployment configuration missing');
  if (bytes.length > 25 * 1024 * 1024) throw Error('Cloudflare Pages single-file limit is 25 MiB');
  const dir = resolve(config.directory);
  const channelFile = join(dir,payload.channel+'.json');
  const manifest = {...payload,url:new URL(filename,base).href};
  // Keep the entire Pages directory across releases; Pages deploys a complete snapshot.
  for (const channel of ['stable','beta']) {
    const published = await anonymous(new URL(channel+'.json',base).href,true);
    if (!published) continue;
    const remote = await published.json();
    const local = JSON.parse(await readFile(join(dir,channel+'.json'),'utf8'));
    if (remote.packageName!==packageName || remote.channel!==channel ||
        !Object.keys(remote).every(key=>remote[key]===local[key])) throw Error('Restore current Pages artifacts before deploying');
    const url = new URL(remote.url), previousFile = url.pathname.split('/').at(-1);
    if (url.href!==new URL(previousFile,base).href || !/^fitcalendar-(?:stable|beta)-[\d]+-[a-f\d]{16}\.apk$/.test(previousFile) ||
        checksum(await readFile(join(dir,previousFile)))!==remote.sha256) throw Error('Restore current Pages APK before deploying');
    if (channel===payload.channel) compatible(remote,payload);
  }
  await mkdir(dir,{recursive:true});
  await writeFile(join(dir,filename),bytes);
  await writeFile(channelFile,json(manifest));
  await writeFile(join(dir,'_headers'),'/*.json\n  Cache-Control: no-cache\n');
  run(process.execPath,[process.env.WRANGLER_JS,'pages','deploy',dir,'--project-name',config.project,'--branch',config.branch]);
  await verifyAsset(manifest.url,manifest);
  await verifyManifest(new URL(payload.channel+'.json',base).href,manifest);
}

async function main([mode,configFile,channel,version,rawCode,apkPath,notesPath,...sources]) {
  if (!configFile || !['configure','prepare','publish'].includes(mode) || (mode!=='configure'&&!notesPath))
    throw Error('Usage: node publish.mjs configure CONFIG | node publish.mjs <prepare|publish> CONFIG <stable|beta> VERSION VERSION_CODE APK NOTES [cloudflare gitee github]');
  const config = JSON.parse(await readFile(configFile,'utf8'));
  if (mode==='configure') {
    const entries=['cloudflare','gitee','github'].map(source=>{
      const base=config[source]?.base;
      if (base && /\/OWNER\//i.test(base)) throw Error('Replace the repository owner in '+source+' base');
      return [source,base?https(base).replace(/\/+$/,''):''];
    });
    const file=fileURLToPath(new URL('../app/src/main/assets/update-sources.json',import.meta.url));
    await writeFile(file,json(Object.fromEntries(entries)));
    console.log('Generated bundled URLs for '+entries.filter(([,base])=>base).map(([source])=>source).join(', '));
    return;
  }
  const apk = resolve(apkPath);
  const bytes = await readFile(apk);
  const payload = manifestFor(channel,version,Number(rawCode),bytes,(await readFile(notesPath,'utf8')).trim());
  validateApk(apk,version,payload.versionCode,config.signers?.[channel],channel);
  const filename = 'fitcalendar-'+channel+'-'+payload.versionCode+'-'+payload.sha256.slice(0,16)+'.apk';
  if (mode==='prepare') { console.log(json({filename, ...payload})); return; }
  const selected = sources.length ? sources : ['cloudflare','gitee','github'];
  const jobs = [...new Set(selected)].map(async source=>{
    if (!['cloudflare','gitee','github'].includes(source)) throw Error('Unknown source '+source);
    const provider = config[source];
    const base = https(provider.base.replace(/\/+$/,'')+'/');
    if (source==='cloudflare') await publishPages(provider,base,payload,bytes,filename);
    else await publishRepository(source,provider,base,payload,bytes,filename);
    console.log(source+': publication and anonymous APK/catalog verification passed');
  });
  const results = await Promise.allSettled(jobs);
  for (const result of results) if (result.status==='rejected') {console.error(result.reason.message);process.exitCode=1;}
}

export { manifestFor, compatible, verifyAsset, publishRepository, publishPages };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
