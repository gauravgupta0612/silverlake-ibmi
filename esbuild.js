// Bundles the extension into dist/extension.js and copies the Mapepire server JAR
// next to it (mapepire-js looks for the JAR in __dirname for its zero-install SSH mode).
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyMapepireJar() {
  const dir = path.join(__dirname, 'node_modules', '@ibm', 'mapepire-js', 'dist');
  const jar = fs.readdirSync(dir).find(f => f.startsWith('mapepire-server-') && f.endsWith('.jar'));
  if (!jar) { console.warn('Mapepire JAR not found – zero-install SQL mode will be unavailable.'); return; }
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(dir, jar), path.join(__dirname, 'dist', jar));
  console.log(`Copied ${jar} to dist/`);
}

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode', 'cpu-features', '*.node'],
    minify: production,
    sourcemap: !production,
    logLevel: 'info',
  });
  copyMapepireJar();
  if (production) { fs.rmSync(path.join(__dirname, 'dist', 'extension.js.map'), { force: true }); }
  if (watch) { await ctx.watch(); } else { await ctx.rebuild(); await ctx.dispose(); }
}
main().catch(e => { console.error(e); process.exit(1); });
