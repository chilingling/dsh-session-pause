/**
 * Browser bundle of the pause button and status pill: `lib/client.js`.
 *
 * DSH Client Modules serve this file under `/plugins` and expect the
 * closure-factory format that `packages/client/tsdown.client.ts` emits in the
 * deepseek-harness repository: the script calls `window.__ModuleLoader__.load`
 * and receives `require`, which answers only the Web shell's platform module
 * table. Those specifiers stay external so React, Cordis, and the UI primitives
 * keep one runtime instance; every other import (the Remote contribution and
 * local modules) is bundled. `*.module.css` compiles through lightningcss into
 * a hashed class map plus one injected style tag, as in the in-repo preset.
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const ID = 'dsh-session-pause'

/** `PLATFORM_MODULES` of `packages/client/web/src/platform.ts`. */
const PLATFORM_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const CSS_PREFIX = '\0dsh-css:'
const CSS_SUFFIX = '.mjs'
const NODE_ENV = JSON.stringify(process.env.NODE_ENV ?? 'production')

function styleModule(fileId: string, css: string, classMap: Readonly<Record<string, string>>): string {
  const tagId = `${ID}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  tsconfig: 'tsconfig.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  // Declarations come from tsc; a dts pass would wrap the banner and footer.
  dts: false,
  sourcemap: true,
  // lib/host is emitted by tsc before this build.
  clean: false,
  deps: {
    neverBundle: (specifier: string) => PLATFORM_MODULES.has(specifier),
    alwaysBundle: (specifier: string) => !PLATFORM_MODULES.has(specifier),
    // npm packages allowed into the bundle; a new one must be added deliberately.
    onlyBundle: [],
  },
  define: {
    'process.env.NODE_ENV': NODE_ENV,
    'import.meta.env.MODE': NODE_ENV,
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-session-pause-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const file = importer === undefined ? source : resolve(dirname(importer), source)
      return CSS_PREFIX + file + CSS_SUFFIX
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const file = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(file)
      const { code, exports } = transform({
        filename: file,
        code: await readFile(file),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, entry] of Object.entries(exports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        classMap[local] = entry.name
      }
      return styleModule(file, code.toString(), classMap)
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
