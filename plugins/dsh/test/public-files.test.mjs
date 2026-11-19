// Public-file preview tests: markdown/JSON classification, sandboxed HTML,
// ZIP root rules and archive hardening. Fixtures are generated in-memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PublicFileError,
  buildFilePreview,
  buildHtmlFilePreview,
  buildZipFilePreview,
  firstMarkdownHeading,
  fileTypeOf,
} from '../lib/public-files.js';

const PEER = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipBuffer(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const crc = crc32(data);
    const flags = 0x0800;
    const external = entry.external ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(external >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

test('markdown title uses first h1 and falls back to file name', async () => {
  assert.equal(firstMarkdownHeading('# Hello `world`\n\nbody'), 'Hello world');
  const md = await buildFilePreview({ data: Buffer.from('# Hello\n\nBody'), path: 'notes/hello.md' });
  assert.equal(md.kind, 'markdown');
  assert.equal(md.title, 'Hello');
  assert.match(md.text, /Body/);
  const fallback = await buildFilePreview({ data: Buffer.from('plain body'), path: 'notes/plain.md' });
  assert.equal(fallback.title, 'plain');
});

test('versioned JSON posts stay compatible while generic JSON is safe text', async () => {
  const post = {
    schema_version: 1,
    title: '旧帖子',
    format: 'markdown',
    author: { peer_id: PEER, kind: 'user', display_name: 'Alice' },
    published_at: '2026-11-14T10:00:00Z',
    body: '# 旧帖子\n\n正文',
  };
  const parsed = await buildFilePreview({ data: Buffer.from(JSON.stringify(post)), path: 'posts/old.json', servingPeerId: PEER });
  assert.equal(parsed.kind, 'markdown');
  assert.equal(parsed.title, '旧帖子');
  assert.match(parsed.text, /正文/);
  assert.equal(parsed.post.authorName, 'Alice');
  const generic = await buildFilePreview({ data: Buffer.from('{"a":1}'), path: 'data/plain.json' });
  assert.equal(generic.kind, 'json');
  assert.equal(generic.title, 'plain');
  assert.equal(generic.text, '{"a":1}');
  assert.equal(generic.post, null);
});

test('text, image, audio, video and unsupported formats are classified safely', async () => {
  const text = await buildFilePreview({ data: Buffer.from('hello'), path: 'hello.txt' });
  assert.equal(text.kind, 'text');
  assert.equal(text.text, 'hello');
  const image = await buildFilePreview({ data: Buffer.from([1, 2, 3]), path: 'p.png' });
  assert.match(image.dataUrl, /^data:image\/png;base64,/);
  const audio = await buildFilePreview({ data: Buffer.from([1]), path: 'a.mp3' });
  assert.equal(audio.kind, 'audio');
  const video = await buildFilePreview({ data: Buffer.from([1]), path: 'v.mp4' });
  assert.equal(video.kind, 'video');
  assert.equal(fileTypeOf('x.pdf').kind, 'unsupported');
  await assert.rejects(
    () => buildFilePreview({ data: Buffer.from('%PDF'), path: 'x.pdf' }),
    (error) => error instanceof PublicFileError && error.status === 'unsupported',
  );
});

test('single-file HTML strips active content and never reads sibling files', async () => {
  const html = '<html><head><title>T</title><link rel="stylesheet" href="style.css"></head>'
    + '<body onload="x()"><script>alert(1)</script><template><script>templated()</script></template>'
    + '<img src="pic.png"><img src="data:image/png;base64,SU5MSU5F"><img src="https://example.com/a.png">'
    + '<a href="https://example.com">go</a><iframe src="https://example.com"></iframe></body></html>';
  const preview = await buildHtmlFilePreview({ data: Buffer.from(html), path: 'index.html' });
  assert.equal(preview.status, 'resource-error');
  assert.equal(preview.title, 'T');
  assert.doesNotMatch(preview.html, /<script/i);
  assert.doesNotMatch(preview.html, /onload/i);
  assert.doesNotMatch(preview.html, /https:\/\/example\.com/);
  assert.doesNotMatch(preview.html, /<iframe/i);
  assert.doesNotMatch(preview.html, /data:image\/png;base64,Qkc=/);
  assert.doesNotMatch(preview.html, /data:image\/png;base64,UElD/);
  assert.match(preview.html, /data:image\/png;base64,SU5MSU5F/);
  assert.match(preview.html, /Content-Security-Policy/);
  assert.match(preview.html, /script-src 'none'/);
  assert.match(preview.html, /href="#"/);
  assert.equal(preview.missingResources.includes('style.css'), true);
  assert.equal(preview.missingResources.includes('pic.png'), true);
});

test('single HTML reports missing associated files without inventing them', async () => {
  const preview = await buildHtmlFilePreview(
    { data: Buffer.from('<html><body><img src="missing.png"></body></html>'), path: 'hello.html' },
  );
  assert.equal(preview.status, 'resource-error');
  assert.deepEqual(preview.missingResources, ['missing.png']);
  assert.doesNotMatch(preview.html, /src="missing.png"/);
});

test('ZIP root and unique top-level folder index previews inline relative CSS/assets', async () => {
  const rootZip = zipBuffer([
    { name: 'index.html', data: '<html><head><title>Root</title><link rel="stylesheet" href="css/style.css"></head><body><img src="pic.png"></body></html>' },
    { name: 'css/style.css', data: 'body{background:url("../bg.png")}' },
    { name: 'bg.png', data: 'BG' },
    { name: 'pic.png', data: 'PIC' },
  ]);
  const root = await buildZipFilePreview({ data: rootZip, path: 'site.zip' });
  assert.equal(root.status, 'ok');
  assert.equal(root.title, 'Root');
  assert.match(root.html, /data:image\/png;base64,Qkc=/);
  assert.match(root.html, /data:image\/png;base64,UElD/);

  const folderZip = zipBuffer([
    { name: 'site/index.html', data: '<html><head><title>Folder</title></head><body><img src="pic.png"></body></html>' },
    { name: 'site/pic.png', data: 'PIC' },
  ]);
  const folder = await buildZipFilePreview({ data: folderZip, path: 'folder.zip' });
  assert.equal(folder.status, 'ok');
  assert.equal(folder.title, 'Folder');
  assert.match(folder.html, /data:image\/png;base64,UElD/);
});

test('ambiguous or index-less ZIP is an unsupported preview, not a fake page', async () => {
  const ambiguous = zipBuffer([
    { name: 'a/index.html', data: 'a' },
    { name: 'b/index.html', data: 'b' },
  ]);
  await assert.rejects(
    () => buildZipFilePreview({ data: ambiguous, path: 'ambiguous.zip' }),
    (error) => error instanceof PublicFileError && error.status === 'unsupported',
  );
  const noIndex = zipBuffer([{ name: 'readme.txt', data: 'hello' }]);
  await assert.rejects(
    () => buildZipFilePreview({ data: noIndex, path: 'plain.zip' }),
    (error) => error instanceof PublicFileError && error.status === 'unsupported',
  );
});

test('ZIP rejects traversal, duplicates, symlinks and oversized entry counts', async () => {
  for (const entries of [
    [{ name: '../evil', data: 'x' }, { name: 'index.html', data: 'x' }],
    [{ name: 'index.html', data: 'x' }, { name: 'index.html', data: 'y' }],
    [{ name: 'index.html', data: 'x' }, { name: 'link', data: '../etc/passwd', external: 0o120777 << 16 }],
    Array.from({ length: 1025 }, (_, index) => ({ name: `f/${index}.txt`, data: 'x' })),
  ]) {
    await assert.rejects(
      () => buildZipFilePreview({ data: zipBuffer(entries), path: 'bad.zip' }),
      (error) => error instanceof PublicFileError && error.status === 'zip-error',
    );
  }
});
