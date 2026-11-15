// Build the shared Raminga five-page UI with esbuild.
//
// esbuild is the normal devDependency declared in package.json. This script
// only supplies the UI-specific asset layer: CSS, the template and sample
// brand artwork is inlined into one browser-ready IIFE so the DSH adapter can
// embed it without a second HTTP server or a second P2P implementation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const srcRoot = path.join(root, 'src');
const entry = path.join(srcRoot, 'index.js');
const generatedAssetsNamespace = 'raminga-generated-assets';
const outFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist', 'raminga-ui.bundle.js');

function dataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

let assetsCache = null;
function readAssets() {
  if (assetsCache !== null) return assetsCache;
  const dir = path.join(srcRoot, 'assets');
  const assets = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) assets[name] = dataUri(file);
  }
  assetsCache = assets;
  return assets;
}

function inlineAssets(text) {
  const assets = readAssets();
  return text.replace(/assets\/([A-Za-z0-9._-]+)/g, (match, name) => {
    if (!(name in assets)) throw new Error(`missing UI asset: ${name}`);
    return assets[name];
  });
}

function readCss() {
  const order = ['tokens.css', 'workspace.css'];
  const raw = order.map((name) => fs.readFileSync(path.join(srcRoot, 'styles', name), 'utf8')).join('\n');
  // Shadow DOM has no document :root/body; map the two shell selectors while
  // leaving the five-page rules themselves untouched.
  return raw.replace(/:root\b/g, ':host').replace(/(^|[\n{}])\s*body(?=\s*[{,])/g, '$1.rm-ui-root');
}

function readTemplate() {
  const raw = fs.readFileSync(path.join(srcRoot, 'template.html'), 'utf8');
  if (/<script[\s>]/i.test(raw)) throw new Error('shared UI template must not contain scripts');
  const template = inlineAssets(raw);
  if (/src=["']assets\//.test(template)) throw new Error('template asset was not inlined');
  return template;
}

function generatedAssetsModule() {
  return `export const CSS = ${JSON.stringify(readCss())};\n`
    + `export const TEMPLATE = ${JSON.stringify(readTemplate())};\n`
    + `export const ASSETS = ${JSON.stringify(readAssets())};\n`;
}

function ramingaAssetsPlugin() {
  return {
    name: 'raminga-assets',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\/generated-assets\.js$/ }, () => ({
        path: generatedAssetsNamespace,
        namespace: generatedAssetsNamespace,
      }));

      buildApi.onLoad({ filter: /.*/, namespace: generatedAssetsNamespace }, () => ({
        contents: generatedAssetsModule(),
        loader: 'js',
        resolveDir: srcRoot,
      }));

      // Keep the image references in JS/template strings as data URIs. esbuild
      // still owns module resolution, parsing, bundling and the output wrapper.
      buildApi.onLoad({ filter: /\.js$/, namespace: 'file' }, (args) => {
        if (!args.path.startsWith(`${srcRoot}${path.sep}`)) return null;
        return {
          contents: inlineAssets(fs.readFileSync(args.path, 'utf8')),
          loader: 'js',
        };
      });

      // The shared UI is host-agnostic and must not pull in host or runtime
      // packages by accident; only local source and the virtual asset module
      // are allowed.
      buildApi.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === 'entry-point') return null;
        return {
          errors: [{
            text: `shared UI may not import "${args.path}" (only local modules are supported)`,
          }],
        };
      });
    },
  };
}

const result = await build({
  absWorkingDir: root,
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: 'iife',
  globalName: 'RamingaUI',
  platform: 'browser',
  target: 'es2022',
  charset: 'utf8',
  legalComments: 'none',
  write: false,
  logLevel: 'silent',
  banner: { js: '/* Generated from packages/ui/src with esbuild. Do not edit by hand. */' },
  plugins: [ramingaAssetsPlugin()],
});

const output = result.outputFiles?.[0];
if (!output) throw new Error('esbuild produced no UI output');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, output.text);
console.log(`built ${path.relative(root, outFile)} (${output.text.length} bytes)`);
