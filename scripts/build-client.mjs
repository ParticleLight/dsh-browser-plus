/**
 * Build the browser bundle: copy the single-file client source to lib/client.js.
 *
 * The client-modules loader serves the package's \`./client\` export, and the
 * bundle is one file that only requires platform modules (React), so there is
 * nothing to bundle or minify — the copy keeps the shipped artifact identical to
 * the reviewed source. Run by \`npm run build\` and by \`prepack\`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const source = new URL('../client/index.js', import.meta.url)
const output = new URL('../lib/client.js', import.meta.url)

const body = await readFile(source, 'utf8')
if (!body.includes('__ModuleLoader__.load')) {
  throw new Error('client/index.js must register through window.__ModuleLoader__.load')
}
await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await writeFile(output, body)
process.stdout.write('built lib/client.js (' + String(body.length) + ' bytes)\n')
