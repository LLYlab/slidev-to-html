#!/usr/bin/env node
/**
 * Generic Slidev -> single-file HTML converter.
 *
 * It uses the target project's own Slidev installation twice:
 *   1. `slidev build` resolves slides.md, layouts, components, theme and addons
 *      exactly as the project normally does, with hash routing for file://.
 *   2. Vite re-bundles the built entry with code splitting disabled, so all
 *      route/slide chunks become one module.
 * CSS, fonts, images and the JS bundle are then inlined into one .html file.
 *
 * Usage:
 *   node tools/slidev-singlefile.mjs [projectDir] \
 *     [--entry slides.md] [--out deck-standalone.html] [--shim tools/shims/foo.ts]
 *
 * The optional --shim entry is any JS/TS module that installs browser-side
 * replacements for backend calls (e.g. window.fetch('/api/...')); it is bundled
 * to an IIFE and injected before the Slidev app.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {
  access, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises'

const MIME = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

function parseArgs(argv) {
  const options = {
    projectDir: '.',
    entry: 'slides.md',
    out: null,
    shim: null,
    replacements: null,
    keepStage: false,
    minify: true,
  }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--entry') options.entry = argv[++i]
    else if (arg === '--out') options.out = argv[++i]
    else if (arg === '--shim') options.shim = argv[++i]
    else if (arg === '--replacements') options.replacements = argv[++i]
    else if (arg === '--keep-stage') options.keepStage = true
    else if (arg === '--no-minify') options.minify = false
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else rest.push(arg)
  }
  if (rest.length) options.projectDir = rest[0]
  return options
}

function usage() {
  console.log(`Slidev -> single-file HTML

  node tools/slidev-singlefile.mjs [projectDir] [options]

  --entry <file>     Slidev markdown entry (default: slides.md)
  --out <file>       output HTML (default: <project>/slidev-standalone.html)
  --shim <file>      optional JS/TS entry that installs browser-side API shims
  --replacements <json>  optional JSON map of literal text replacements
  --keep-stage       keep the temporary build/stage directories
  --no-minify        keep the JS bundle unminified
  -h, --help         show this help
`)
}

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(full))
    else files.push(full)
  }
  return files
}

/** Inline `url(...)` references of a CSS file, relative to that CSS file. */
async function inlineCssUrls(css, cssFile) {
  let output = css
  const matches = [...output.matchAll(/url\((?!['"]?data:)(['"]?)([^)'"]+)\1\)/g)]
  for (const match of matches) {
    let reference = match[2].trim()
    if (/^(https?:)?\/\//.test(reference) || reference.startsWith('#')) continue
    reference = reference.replace(/[?#].*$/, '')
    const file = path.resolve(path.dirname(cssFile), reference)
    if (!await exists(file)) {
      console.warn(`[singlefile] CSS asset not found: ${reference}`)
      continue
    }
    const data = await readFile(file)
    output = output.split(match[0]).join(`url(data:${mimeFor(file)};base64,${data.toString('base64')})`)
  }
  return output
}

/** Inline local src/href attributes that point at build assets or public files. */
async function inlineHtmlAssets(html, stageDir) {
  let output = html
  const attributes = [...output.matchAll(/\b(src|href|poster)="([^"]+)"/g)]
  for (const match of attributes) {
    const reference = match[2]
    if (!reference || /^(data:|https?:|\/\/|#|mailto:|javascript:)/.test(reference)) continue
    const file = path.resolve(stageDir, reference.replace(/^\.?\//, ''))
    if (!await exists(file)) continue
    if ((await stat(file)).isDirectory()) continue
    const data = await readFile(file)
    output = output.split(match[0]).join(`${match[1]}="data:${mimeFor(file)};base64,${data.toString('base64')}"`)
  }
  return output
}

function escapeScript(code) {
  return code.replace(/<\/script/gi, '<\\/script')
}

async function bundleShim(vite, shimPath, projectDir, minify) {
  const result = await vite.build({
    configFile: false,
    root: projectDir,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      target: 'es2022',
      minify,
      cssCodeSplit: false,
      assetsInlineLimit: 100_000_000,
      lib: {
        entry: shimPath,
        formats: ['iife'],
        name: 'SlidevApiShim',
        fileName: 'shim',
      },
      rollupOptions: { output: { codeSplitting: false } },
    },
  })
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output ?? []) : result.output
  const chunk = outputs.find((item) => item.type === 'chunk')
  if (!chunk) throw new Error('Could not bundle API shim')
  return chunk.code
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }

  const projectDir = path.resolve(args.projectDir)
  const entry = args.entry
  if (!await exists(path.join(projectDir, entry))) {
    throw new Error(`Entry not found: ${path.join(projectDir, entry)}`)
  }
  const outFile = path.resolve(
    projectDir,
    args.out || path.join(path.dirname(entry), `${path.basename(entry, path.extname(entry))}-standalone.html`),
  )

  process.chdir(projectDir)
  const requireFromProject = createRequire(path.join(projectDir, 'package.json'))
  async function resolvePackageEntry(name) {
    const pkgPath = requireFromProject.resolve(`${name}/package.json`)
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    const rootExport = pkg.exports?.['.'] ?? pkg.exports
    let relative = typeof rootExport === 'string'
      ? rootExport
      : rootExport?.import ?? rootExport?.module ?? rootExport?.default
    if (Array.isArray(relative)) relative = relative[0]?.import ?? relative[0]?.default ?? relative[0]
    if (typeof relative !== 'string') throw new Error(`Cannot find the ESM entry of ${name}`)
    return path.resolve(path.dirname(pkgPath), relative)
  }
  const cliEntry = await resolvePackageEntry('@slidev/cli')
  const viteEntry = await resolvePackageEntry('vite')
  const cli = await import(pathToFileURL(cliEntry).href)
  const vite = await import(pathToFileURL(viteEntry).href)
  const cliDist = path.dirname(cliEntry)
  const buildFiles = (await readdir(cliDist)).filter((file) => /^build-.*\.mjs$/.test(file))
  if (!buildFiles.length) throw new Error('This Slidev version does not expose a build module')
  const { build } = await import(pathToFileURL(path.join(cliDist, buildFiles[0])).href)

  const stageRoot = await mkdtemp(path.join(os.tmpdir(), 'slidev-singlefile-'))
  const stageDir = path.join(stageRoot, 'stage')
  const bundleDir = path.join(stageRoot, 'bundle')

  try {
    console.log(`[singlefile] resolving ${entry} with Slidev…`)
    const options = await cli.resolveOptions({ entry, routerMode: 'hash', base: './' }, 'build')
    const slideCount = options.data.slides.length
    console.log(`[singlefile] ${slideCount} slides, theme ${options.theme}`)

    await build(options, {
      base: './',
      build: { outDir: stageDir, emptyOutDir: true, modulePreload: false },
    }, { entry, routerMode: 'hash' })

    const htmlFile = path.join(stageDir, 'index.html')
    let html = await readFile(htmlFile, 'utf8')
    const scriptMatch = html.match(/<script[^>]*\bsrc="([^"]+)"[^>]*><\/script>/)
    if (!scriptMatch) throw new Error('Built index.html has no entry script')
    const entryScript = path.resolve(stageDir, scriptMatch[1].replace(/^\.?\//, ''))

    const linkedCss = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]
      .map((match) => path.resolve(stageDir, match[1].replace(/^\.?\//, '')))
    // Async routes (overview/presenter/slide chunks) load their CSS via the
    // Vite preload helper. All chunks are inlined, so inline every stylesheet.
    const allCss = (await walk(stageDir)).filter((file) => file.endsWith('.css'))
    const cssFiles = [...linkedCss, ...allCss.filter((file) => !linkedCss.includes(file)).sort()]
    let css = ''
    for (const file of cssFiles) {
      if (!await exists(file)) continue
      css += await inlineCssUrls(await readFile(file, 'utf8'), file)
      css += '\n'
    }

    console.log('[singlefile] re-bundling the Slidev app into one module…')
    const result = await vite.build({
      configFile: false,
      root: stageDir,
      base: './',
      logLevel: 'warn',
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        write: false,
        outDir: bundleDir,
        target: 'es2022',
        minify: args.minify,
        modulePreload: false,
        cssCodeSplit: false,
        assetsInlineLimit: 100_000_000,
        lib: { entry: entryScript, formats: ['es'], fileName: 'app' },
        rollupOptions: { output: { codeSplitting: false } },
      },
    })
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output ?? []) : result.output
    const jsChunks = outputs.filter((item) => item.type === 'chunk')
    if (jsChunks.length !== 1) {
      throw new Error(`Expected one JS chunk, got ${jsChunks.length}. The Slidev app could not be flattened.`)
    }
    let js = jsChunks[0].code
    // Rolldown leaves //#region markers with the temporary build path. They are
    // only debugging noise and must not leak local paths into the published HTML.
    js = js.replace(/^\s*\/\/#(?:end)?region.*$/gm, '')
    // The first build embedded Vite's __vitePreload helper and chunk-name map.
    // Every chunk is now inlined, so dependency preloading is redundant and
    // would try to fetch files that do not exist next to the single HTML.
    const before = js
    js = js.replace(
      /([A-Za-z_$][\w$]*)\s*=\s*function\(e, t, n\) \{\s*let r = Promise\.resolve\(\);[\s\S]*?return e\(\)\.catch\(i\);\s*\}\);\s*\}/,
      '$1 = function(e) { return e() }',
    )
    if (js === before) console.warn('[singlefile] Vite preload helper not found; chunk preloads may remain')
    if (args.replacements) {
      const mapFile = path.resolve(args.replacements)
      const map = JSON.parse(await readFile(mapFile, 'utf8'))
      for (const [from, to] of Object.entries(map)) js = js.split(from).join(to)
    }
    for (const asset of outputs.filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))) {
      css += `\n${await inlineCssUrls(String(asset.source), path.join(bundleDir, asset.fileName))}`
    }

    let shim = ''
    if (args.shim) {
      const shimPath = path.resolve(args.shim)
      if (!await exists(shimPath)) throw new Error(`Shim not found: ${shimPath}`)
      console.log('[singlefile] bundling API shim…')
      shim = await bundleShim(vite, shimPath, projectDir, args.minify)
    }

    // Remove the original loading tags; everything is inlined below.
    html = html
      .replace(/<script[^>]*\bsrc="[^"]+"[^>]*><\/script>\s*/g, '')
      .replace(/<link[^>]*rel="modulepreload"[^>]*>\s*/g, '')
      .replace(/<link[^>]*rel="stylesheet"[^>]*>\s*/g, '')
      .replace(/<link[^>]*rel="icon"[^>]*>\s*/g, '')

    const safeCss = css.replace(/<\/style/gi, '<\\/style')
    const safeJs = escapeScript(js)
    const safeShim = escapeScript(shim)
    const generated = new Date().toISOString()
    const injection = [
      safeShim ? `<script>${safeShim}</script>` : '',
      `<script type="module">${safeJs}</script>`,
    ].filter(Boolean).join('\n')

    // Use function replacements: the bundled JS/CSS contains "$&", "$1", etc.,
    // which would otherwise be interpreted as replacement patterns.
    html = html.replace('</head>', () => `<style>${safeCss}</style>\n</head>`)
    html = html.replace('</body>', () => `${injection}\n</body>`)
    html = await inlineHtmlAssets(html, stageDir)
    html = html.replace('<head>', () => `<head>\n<!--
  Slidev single-file build.
  Project: ${path.basename(projectDir)}
  Entry: ${entry}
  Slides: ${slideCount}
  Generated: ${generated}
  Everything (Vue app, slide chunks, theme CSS, fonts, optional API shim) is inlined.
-->`)

    await writeFile(outFile, html, 'utf8')
    const size = (await stat(outFile)).size
    console.log(`[singlefile] wrote ${path.relative(projectDir, outFile)} (${(size / 1024 / 1024).toFixed(2)} MiB)`)
  } finally {
    if (args.keepStage) console.log(`[singlefile] stage kept at ${stageRoot}`)
    else await rm(stageRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[singlefile] ${error?.stack || error}`)
  process.exitCode = 1
})
