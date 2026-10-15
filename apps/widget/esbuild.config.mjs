// Bundles the widget into a single self-contained IIFE (esbuild).
// Socket.IO is bundled in — the host page needs no other script tags.
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2018'],
  outfile: 'dist/widget.js',
  legalComments: 'none',
  logLevel: 'info',
});
