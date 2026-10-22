# slidev-to-html

Generic **Slidev → single-file HTML** converter, with a dependency doctor and a one-command installer.

It builds any Slidev project through its own `@slidev/cli` pipeline, re-bundles the Slidev app into one module, inlines CSS/fonts, switches to hash routing, and writes one HTML file that opens from `file://` without Node, Python or a web server.

## Quick start

Requires Node.js **22.12+** (24 LTS recommended).

```sh
npm run setup        # npm ci + recommended VS Code extensions + doctor
npm run doctor       # check dependencies only
npm run build:example
```

`npm run build:example` converts the tiny fixture in [`examples/minimal`](examples/minimal) and writes `examples/minimal/slides-standalone.html`.

Windows: double-click `install.cmd`. macOS / Linux: `sh install.sh`.

## Convert a deck

```sh
node tools/slidev-singlefile.mjs /path/to/slidev-deck --out deck.html
```

Or from the deck directory:

```sh
node /path/to/tools/slidev-singlefile.mjs . --out deck.html
```

The target project needs its own dependencies installed (`@slidev/cli` and `vite`).

### Options

| Option | Description |
| --- | --- |
| `[projectDir]` | Slidev project directory (default: current directory) |
| `--entry <file>` | Markdown entry (default: `slides.md`) |
| `--out <file>` | Output HTML (default: `<entry dir>/<entry name>-standalone.html`) |
| `--shim <file>` | Optional JS/TS entry that installs browser-side `/api/*` replacements; bundled as an IIFE |
| `--replacements <json>` | Optional JSON map of literal text replacements (`{"old":"new"}`) applied to the JS bundle |
| `--keep-stage` | Keep temporary build directories for debugging |
| `--no-minify` | Keep the JS bundle unminified |
| `-h`, `--help` | Show help |

### API shim

Slidev decks that call a local backend (for example `fetch('/api/orbit')`) have no server in a single-file build. Provide a module that installs a `window.fetch` replacement:

```ts
// my-api-shim.ts
const nativeFetch = window.fetch.bind(window)

window.fetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : input.url)
  if (url.endsWith('/api/hello')) {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return nativeFetch(input, init)
}
```

```sh
node tools/slidev-singlefile.mjs . --shim my-api-shim.ts
```

The shim is bundled by Vite, so relative imports are allowed.

## How it works

1. Resolve the target project with its own Slidev installation (`routerMode: hash`, `base: './'`).
2. Run Slidev's build into a temporary directory.
3. Re-bundle the built entry with Vite (`codeSplitting: false`) so route and slide chunks become one module.
4. Inline every stylesheet and CSS `url(...)` asset as data URIs, remove chunk-preload logic, and inject the one module into the HTML.
5. Optionally inject the API shim and apply text replacements.

## Installer and doctor

- `npm run setup` checks Node/npm, runs `npm ci`, installs the recommended VS Code extensions (`antfu.slidev`, `Vue.volar`), detects Python 3, and finishes with `npm run doctor`.
- `npm run doctor` checks Node, npm, Python 3, `@slidev/cli`, Vite, the Slidev binary, and VS Code/extensions. Missing required dependencies exit non-zero. `--json` is supported.
- Setup flags: `--no-vscode`, `--force`, `--build`.

## CI

`.github/workflows/ci.yml` runs on push / PR:

1. `npm ci`
2. `npm run doctor`
3. `npm run build:example`
4. upload the generated example HTML

## Known limitations

- Depends on the installed Slidev version exposing its internal `dist/build-*.mjs` (tested with Slidev 53.0.0). Re-check after a Slidev upgrade.
- Assets that the app fetches at runtime by absolute path (`/assets/...`) are not inlined automatically; build-time imports and CSS assets are.
- A non-fatal `Failed to patch FloatingVue` console warning can appear; slides, navigation and most features work, but some floating menus/tooltips may be incomplete.
- Presenter/overview/shortcuts pages are included, so output is larger than a hand-trimmed deck.
- The entry markdown should be UTF-8 without BOM (a BOM makes Slidev treat frontmatter as body text).

## Files

| Path | Purpose |
| --- | --- |
| `tools/slidev-singlefile.mjs` | Generic converter |
| `tools/doctor.mjs` | Dependency doctor |
| `tools/setup.mjs` | Installer |
| `install.cmd` / `install.sh` | One-click installer entry points |
| `examples/minimal` | Two-slide test fixture |
| `.github/workflows/ci.yml` | Dependency check + build |
