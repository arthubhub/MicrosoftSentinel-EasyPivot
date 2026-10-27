import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'fs';

const userscriptHeaderTemplate = readFileSync('./userscript-header.txt', 'utf-8');
const { version } = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };
const userscriptHeader = userscriptHeaderTemplate.replace('{{VERSION}}', version);

/**
 * Custom plugin to prepend the userscript header to the built output.
 * The banner rollup option doesn't work reliably with IIFE format
 * because the IIFE wrapper gets placed before the banner.
 */
function userscriptBanner(): Plugin {
  return {
    name: 'userscript-banner',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') {
          chunk.code = userscriptHeader + '\n' + chunk.code;
        }
      }
    },
  };
}

export default defineConfig({
  // Runtime access to the script version (health diagnostic, N6, #12): same
  // package.json read as the {{VERSION}} header substitution above, so the
  // two never drift apart.
  define: {
    __SCRIPT_VERSION__: JSON.stringify(version),
  },
  build: {
    lib: {
      entry: 'src/main.ts',
      formats: ['iife'],
      name: 'SentinelEasyPivot',
      fileName: () => 'sentinel-easypivot.user.js',
    },
    outDir: 'dist',
    minify: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [userscriptBanner()],
});
