// Builds dist/: bundles lesson Markdown, copies assets, and wraps index.html in a full
// HTML document (the Artifact viewer adds this skeleton itself; a plain web server does not).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [join(root, 'tools/build-content.mjs')], { stdio: 'inherit' });
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
cpSync(join(root, 'css'), join(dist, 'css'), { recursive: true });
cpSync(join(root, 'js'), join(dist, 'js'), { recursive: true });
const body = readFileSync(join(root, 'index.html'), 'utf8');
const [head, ...rest] = body.split('\n<div class="app"');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
${head.trim()}
</head>
<body>
<div class="app"${rest.join('\n<div class="app"')}
</body>
</html>
`;
writeFileSync(join(dist, 'index.html'), html);
console.log('dist/ ready');
