#!/usr/bin/env node
/**
 * One-command setup / installer.
 *
 *   npm run setup
 *   node tools/setup.mjs --build
 *   node tools/setup.mjs --no-vscode
 *
 * Installs Node dependencies, optionally the recommended VS Code extensions,
 * then runs the dependency doctor and prints next steps.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.noDeprecation = true

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const noVscode = argv.includes('--no-vscode')
const force = argv.includes('--force')
const build = argv.includes('--build')
const help = argv.includes('--help') || argv.includes('-h')

if (help) {
  console.log(`Usage: node tools/setup.mjs [options]

  --no-vscode   skip VS Code extension installation
  --force       run npm ci even when node_modules exists
  --build       build the minimal example afterwards
  -h, --help    show this help
`)
  process.exit(0)
}

function step(message) {
  console.log(`\n== ${message}`)
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: options.stdio || 'inherit',
    timeout: options.timeout || 0,
  })
}

function commandVersion(cmd, args) {
  const result = run(cmd, args, { stdio: 'pipe', timeout: 20_000 })
  if (result.status === 0) return (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0]
  return null
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

// 1. Node
step('Checking Node.js')
const nodeVersion = process.versions.node
if (!gte(nodeVersion, '22.12.0')) {
  console.error(`Node.js ${nodeVersion} is too old. Install Node.js 22.12+ (24 LTS recommended): https://nodejs.org/`)
  process.exit(1)
}
console.log(`Node.js v${nodeVersion} OK`)

// 2. npm dependencies
step('Installing Node dependencies')
const hasModules = existsSync(path.join(root, 'node_modules'))
const hasLock = existsSync(path.join(root, 'package-lock.json'))
if (!hasModules || force) {
  const command = hasLock ? 'npm ci' : 'npm install'
  console.log(`Running ${command} (this can take a minute)…`)
  const result = run('npm', hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'])
  if (result.status !== 0) {
    console.error('Dependency installation failed.')
    process.exit(result.status || 1)
  }
} else {
  console.log('node_modules already exists; skipping (use --force to reinstall)')
}

// 3. VS Code extensions
if (!noVscode && commandVersion('code', ['--version'])) {
  step('Installing recommended VS Code extensions')
  for (const id of ['antfu.slidev', 'Vue.volar']) {
    const result = run('code', ['--install-extension', id, '--force'], { stdio: 'pipe', timeout: 120_000 })
    if (result.status === 0) console.log(`installed ${id}`)
    else console.warn(`could not install ${id} (open VS Code once and retry, or install it from the Extensions view)`)
  }
} else if (!noVscode) {
  console.log('\nVS Code CLI not found; skipping editor extensions (optional).')
}

// 4. Python (optional; some decks use it as a backend)
step('Checking Python 3')
const candidates = []
if (process.env.KEPLER_PYTHON) candidates.push([process.env.KEPLER_PYTHON, ['--version']])
candidates.push(['py', ['-3', '--version']], ['python3', ['--version']], ['python', ['--version']])
let pythonFound = false
for (const [cmd, args] of candidates) {
  const version = commandVersion(cmd, args)
  if (version && /^Python 3\./i.test(version)) {
    console.log(`${version} via ${cmd}${cmd === 'py' ? ' -3' : ''}`)
    pythonFound = true
    break
  }
}
if (!pythonFound) {
  console.warn('Python 3 not found. The converter does not need it; some decks use a local Python backend.')
  console.warn('Install Python 3 if your deck needs it.')
}

// 5. Optional builds
if (build) {
  step('Building the example single-file HTML')
  const result = run('npm', ['run', 'build:example'])
  if (result.status !== 0) {
    console.error('build:example failed.')
    process.exit(result.status || 1)
  }
}

// 6. Doctor
step('Running dependency doctor')
const doctor = run('node', ['tools/doctor.mjs'])
if (doctor.status !== 0) {
  console.error('\nSome required dependencies are still missing.')
  process.exit(doctor.status || 1)
}

console.log(`
Setup complete.

  npm run doctor        re-run the dependency check
  npm run build:example convert the minimal example
  npm run setup         re-run this installer

  node tools/slidev-singlefile.mjs /path/to/slidev-deck --out deck.html
`)
