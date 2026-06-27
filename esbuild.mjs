import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  treeShaking: true,
};

const webviewConfig = {
  entryPoints: ['webview/src/index.tsx'],
  bundle: true,
  outdir: 'dist/webview',
  platform: 'browser',
  target: 'es2020',
  format: 'esm',
  loader: {
    '.css': 'css',
    '.svg': 'file',
    '.png': 'file',
  },
  sourcemap: !production,
  minify: production,
  treeShaking: true,
};

async function build() {
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('[watch] Build started...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
    console.log('[build] Done.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
