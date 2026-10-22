#!/usr/bin/env node
/**
 * Dependency doctor for the Slidev single-file project.
 *
 *   node tools/doctor.mjs
 *   node tools/doctor.mjs --json
 *
 * Exit code: 0 when nothing critical is missing, 1 when a FAIL row exists.
 * Python and VS Code are warnings: the standalone HTML does not need them.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.noDeprecation = true

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const jsonMode = process.argv.includes('--json')
const rows = []
const add = (name, status, detail, hint = '') => rows.push({ name, status, detail, hint })

function run(cmd, args, timeout = 20_000) {
  try {
    const result = spawnSync(cmd, args, {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout,
    })
    if (result.status === 0) return (result.stdout || result.stderr || '').trim()
  } catch {
    /* command missing */
  }
  return null
}

function firstLine(value) {
  return value ? value.split(/\r?\n/)[0].trim() : ''
}

function versionOf(packageName) {
  const file = path.join(root, 'node_modules', ...packageName.split('/'), 'package.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version
  } catch {
    return null
  }
}

function gte(version, minimum) {
  const a = version.split('.').map(Number)
  const b = minimum.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true
    if ((a[i] || 0) < (b[i] || 0)) return false
  }
  return true
}

// Node.js
const nodeVersion = process.versions.node
add(
  'Node.js',
  gte(nodeVersion, '22.12.0') ? 'ok' : 'fail',
  `v${nodeVersion}`,
  'Install Node.js 22.12+ (24 LTS recommended): https://nodejs.org/',
)

// npm
const npmVersion = run('npm', ['--version'])
add('npm', npmVersion ? 'ok' : 'fail', npmVersion || 'not found', 'npm ships with Node.js')

// Python 3: only needed by the live Python orbit lab in development.
const pythonCandidates = []
if (process.env.KEPLER_PYTHON) {
  pythonCandidates.push({ cmd: process.env.KEPLER_PYTHON, args: ['--version'], label: `${process.env.KEPLER_PYTHON} (KEPLER_PYTHON)` })
}
pythonCandidates.push(
  { cmd: 'py', args: ['-3', '--version'], label: 'py -3' },
  { cmd: 'python3', args: ['--version'], label: 'python3' },
  { cmd: 'python', args: ['--version'], label: 'python' },
)
let python = null
for (const candidate of pythonCandidates) {
  const output = run(candidate.cmd, candidate.args)
  if (output && /^Python 3\./i.test(firstLine(output))) {
    python = { label: candidate.label, version: firstLine(output) }
    break
  }
}
add(
  'Python 3 (optional)',
  python ? 'ok' : 'warn',
  python ? `${python.version} via ${python.label}` : 'not found',
  python ? '' : 'Some decks call a local Python backend; the converter does not need it.',
)

// Project dependencies
const pkgFile = path.join(root, 'package.json')
if (!existsSync(pkgFile)) {
  add('package.json', 'fail', 'missing', 'Run this from the project root')
} else {
  add('package.json', 'ok', 'found')
}
add(
  'package-lock.json',
  existsSync(path.join(root, 'package-lock.json')) ? 'ok' : 'warn',
  existsSync(path.join(root, 'package-lock.json')) ? 'found' : 'missing',
  'Run npm install to create one',
)

const dependencyChecks = [
  ['@slidev/cli', 'Slidev CLI'],
  ['vite', 'Vite'],
]
for (const [packageName, label] of dependencyChecks) {
  const version = versionOf(packageName)
  add(
    label,
    version ? 'ok' : 'fail',
    version ? `v${version}` : 'not installed',
    version ? '' : 'Run npm ci (or npm run setup)',
  )
}

const slidevBin = process.platform === 'win32'
  ? path.join(root, 'node_modules', '.bin', 'slidev.cmd')
  : path.join(root, 'node_modules', '.bin', 'slidev')
add('Slidev binary', existsSync(slidevBin) ? 'ok' : 'fail', existsSync(slidevBin) ? 'node_modules/.bin/slidev' : 'missing', 'Run npm ci')

// VS Code + recommended extensions (optional, used by the editing setup).
const codeVersion = firstLine(run('code', ['--version']))
add(
  'VS Code CLI',
  codeVersion ? 'ok' : 'warn',
  codeVersion ? `v${codeVersion}` : 'not on PATH',
  codeVersion ? '' : 'Optional; install VS Code and enable the code command.',
)
if (codeVersion) {
  const extensions = run('code', ['--list-extensions'], 30_000)
  if (extensions === null) {
    add('VS Code extensions', 'warn', 'could not list', 'Open VS Code once and retry')
  } else {
    const installed = new Set(extensions.split(/\r?\n/).map((item) => item.trim().toLowerCase()))
    const wanted = [
      ['antfu.slidev', 'Slidev'],
      ['vue.volar', 'Vue'],
    ]
    const missing = wanted.filter(([id]) => !installed.has(id)).map(([, name]) => name)
    add(
      'VS Code extensions',
      missing.length ? 'warn' : 'ok',
      missing.length ? `missing: ${missing.join(', ')}` : 'Slidev, Vue',
      missing.length ? 'Run npm run setup (or install them from the Extensions view)' : '',
    )
  }
}

// Output
const counts = { ok: 0, warn: 0, fail: 0 }
for (const row of rows) counts[row.status] += 1

if (jsonMode) {
  console.log(JSON.stringify({ ok: counts.fail === 0, counts, rows }, null, 2))
} else {
  const color = process.stdout.isTTY && !process.env.NO_COLOR
  const label = { ok: 'OK', warn: 'WARN', fail: 'FAIL' }
  const paint = (status, text) => {
    if (!color) return text
    const code = status === 'ok' ? 32 : status === 'warn' ? 33 : 31
    return `\u001b[${code}m${text}\u001b[0m`
  }
  console.log('\nSlidev single-file — dependency doctor\n')
  for (const row of rows) {
    console.log(`${paint(row.status, `[${label[row.status]}]`.padEnd(6))} ${row.name.padEnd(26)} ${row.detail}`)
    if (row.status !== 'ok' && row.hint) console.log(`       ${row.hint}`)
  }
  console.log(`\nResult: ${counts.ok} ok, ${counts.warn} warning(s), ${counts.fail} failure(s)`)
  if (counts.fail) console.log('Run `npm run setup` to install missing Node dependencies.')
}

process.exitCode = counts.fail ? 1 : 0
