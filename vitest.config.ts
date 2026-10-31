import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

export default defineConfig({
  plugins: [{
    // The host service declares its Remote methods with standard decorators; lower them with tsc first.
    name: 'standard-decorators',
    enforce: 'pre',
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, sourceMap: true },
      })
      const lowered = result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n')
      return result.sourceMapText === undefined ? { code: lowered } : { code: lowered, map: result.sourceMapText }
    },
  }],
  resolve: {
    // The Loader composition spec mounts this package by name; resolve it to source.
    alias: { 'dsh-session-pause': fileURLToPath(new URL('./src/host/index.ts', import.meta.url)) },
  },
  test: {
    // Process the Loader and Include through Vite so their dynamic plugin imports see the alias above.
    server: { deps: { inline: [/@deepseek-ai\/cordis-plugin-(loader|include)/] } },
    include: ['tests/**/*.spec.ts'],
  },
})
