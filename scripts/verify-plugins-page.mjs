#!/usr/bin/env node
/**
 * Verifier for the two homes of the smooth-stream switches.
 *
 * Why this file exists: the switch rows have two faces assembled from ONE
 * component — the 0.1.5 Settings card (`settings.plugin.item`) and the 0.1.7
 * sidebar Plugins page (`plugins.item`). Every failure mode that matters is a
 * SILENT one, so none of them is visible to a source-level assertion:
 *
 *   1. HEADLESS PAGE — `view: 'page'` must arrive expanded and without the
 *      card's own header: the page host already drew the title, icon and
 *      breadcrumb, and a page that arrives as a collapsed card leaves the user
 *      one click away from the switches they opened it for.
 *   2. CARD REGRESSION — the `card` face must keep its header and start
 *      collapsed; the page variant may not leak into the Settings card.
 *   3. SUMMARY LOSS — `view: 'summary'` must return the dictionary's one-liner.
 *      An empty summary view makes the Plugins page fall back to the package
 *      description, which is a different sentence in a different language.
 *
 * Both renders use `react-dom/server` against the BUILT bundle, i.e. the same
 * bytes the browser loads, and the expected copy is read out of `locales.ts`
 * rather than retyped here.
 *
 * Run: node scripts/verify-plugins-page.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')
const LOCALE = join(HERE, '..', 'src', 'client', 'locales.ts')
/** The version the shipped bundle reports, read from the manifest so a
 * release bump cannot leave a stale literal behind in the fixture below. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(HERE, '..', 'package.json'), 'utf8'),
).version

const react = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

let checks = 0
function check(label, fn) {
  fn()
  checks += 1
  console.log(`  ok  ${label}`)
}

/** Unescape the entities `renderToStaticMarkup` emits for text nodes. */
function unescapeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Read one `key: '…'` string literal out of the zh dictionary block. */
function dictValue(block, key) {
  const pattern = new RegExp(`\\b${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`)
  const match = pattern.exec(block)
  assert.ok(match !== null, `locales.ts declares ${key}`)
  return match[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

const localeSource = readFileSync(LOCALE, 'utf8')
const zhStart = localeSource.indexOf('export const zh')
assert.ok(zhStart > 0, 'locales.ts declares the zh dictionary')
// The zh block is the last declaration in the file, so it runs to the next
// top-level export — or to the end when there is none.
const zhNext = localeSource.indexOf('\nexport const ', zhStart + 1)
const zh = localeSource.slice(zhStart, zhNext === -1 ? undefined : zhNext)
const COPY = {
  title: dictValue(zh, 'title'),
  description: dictValue(zh, 'description'),
  enabled: dictValue(zh, 'enabled'),
  controlScroll: dictValue(zh, 'controlScroll'),
  preset: dictValue(zh, 'preset'),
  save: dictValue(zh, 'save'),
  discard: dictValue(zh, 'discard'),
  developmentVersion: dictValue(zh, 'developmentVersion'),
}

// ---------------------------------------------------------------- bundle load

const previousWindow = globalThis.window
const previousDocument = globalThis.document
let entry = null
globalThis.window = {
  __ModuleLoader__: {
    load(payload) {
      entry = payload
    },
  },
}
// The bundle injects its stylesheet through `document`; nothing is rendered to a
// real DOM here, so one inert sink keeps the module table importable.
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: () => {} },
  querySelector: () => null,
  querySelectorAll: () => [],
}

let mod
try {
  require(BUNDLE)
  assert.ok(entry !== null, 'the bundle registered with the module loader')
  assert.equal(entry.id, 'dsh-smooth-stream', 'the bundle keeps its module id')
  mod = entry.factory((id) => {
    if (id === 'react') return react
    if (id === 'react-dom') return require('react-dom')
    if (id === 'react/jsx-runtime') return require('react/jsx-runtime')
    // `primitives-compat` probes the module tables by name and falls back to its
    // own placeholders, so empty tables are the honest 0.1.7-without-icons case.
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    if (id === '@deepseek-ai/dsh-client-ui-attachment') return {}
    throw new Error(`unexpected require in the shim: ${id}`)
  })
} finally {
  globalThis.window = previousWindow
  globalThis.document = previousDocument
}

const { SmoothStreamCard, SmoothStreamPluginsPage } = mod
assert.equal(typeof SmoothStreamPluginsPage, 'function', 'the bundle exports the Plugins page entry')
assert.equal(typeof SmoothStreamCard, 'function', 'the bundle exports the settings card')

/** One ready, writable, dirty snapshot — the state both faces must render. */
const SNAPSHOT = {
  status: 'ready',
  writable: true,
  saving: false,
  dirty: true,
  failed: false,
  available: true,
  version: PACKAGE_VERSION,
  installation: 'development',
  enabled: true,
  controlScroll: true,
  preset: 'silky',
  motionPreference: 'auto',
  thinkAutoExpand: true,
  logarithmicFade: true,
  debugAvailable: true,
  debugEnabled: false,
  debugTuning: {},
  canUpgrade: false,
  upgrading: false,
  restartRequired: false,
  upgradeFailed: false,
}

const calls = []
function face() {
  return {
    hooks: { smoothStreamCard: { getSnapshot: () => SNAPSHOT, subscribe: () => () => {} } },
    useSmoothStreamCard: (selector) => selector(SNAPSHOT),
    edit: (patch) => calls.push(['edit', patch]),
    save: () => calls.push(['save']),
    discard: () => calls.push(['discard']),
    reload: () => calls.push(['reload']),
    upgrade: () => calls.push(['upgrade']),
  }
}

const t = (key) => COPY[key] ?? key
const props = (extra) => ({ ...face(), t, ...extra })
const markup = (element) => unescapeHtml(renderToStaticMarkup(element))

/** The class attribute of the outermost rendered element. */
function rootClass(html) {
  const match = /^<li class="([^"]*)"/.exec(html)
  assert.ok(match !== null, 'the entry renders a single root <li>')
  return match[1]
}

// ------------------------------------------------------------------- checks

check('the summary view is the dictionary one-liner', () => {
  const html = markup(react.createElement(SmoothStreamPluginsPage, props({ view: 'summary' })))
  assert.equal(html, COPY.description)
  assert.ok(!COPY.description.startsWith('toolbox'), 'the summary is this plugin’s own copy')
})

check('the summary view survives without a locale binding', () => {
  const html = markup(react.createElement(SmoothStreamPluginsPage, { ...face(), view: 'summary' }))
  assert.equal(html, COPY.description)
})

check('the page view opens the switches the entry advertises', () => {
  const html = markup(react.createElement(SmoothStreamPluginsPage, props({ view: 'page' })))
  for (const label of [COPY.enabled, COPY.controlScroll, COPY.preset]) {
    assert.ok(html.includes(label), `the page renders "${label}"`)
  }
  assert.ok(html.includes(COPY.save) && html.includes(COPY.discard), 'the page carries its own save controls')
  assert.ok(html.includes('type="checkbox"'), 'the page renders the switches expanded, not collapsed')
})

check('the page view drops the card chrome the host redraws', () => {
  const html = markup(react.createElement(SmoothStreamPluginsPage, props({ view: 'page' })))
  assert.ok(!html.includes('aria-expanded'), 'no collapse control on the page face')
  // Both strings also occur inside field labels and hints, so the check is for
  // the header's own text nodes — the ones the page host draws instead.
  assert.ok(!html.includes(`>${COPY.title}<`), 'the host owns the title')
  assert.ok(!html.includes(`>${COPY.description}<`), 'the host owns the one-liner')
  assert.ok(!html.includes(SNAPSHOT.version), 'no version badge inside the page body')
  assert.ok(!html.includes('未保存'), 'no unsaved badge inside the page body')
})

check('an unknown or missing view still shows the switches', () => {
  for (const view of [undefined, 'compact', null]) {
    const html = markup(react.createElement(SmoothStreamPluginsPage, props({ view })))
    assert.ok(html.includes(COPY.enabled), `view=${String(view)} falls back to the page face`)
  }
})

check('the settings card keeps its header and starts collapsed', () => {
  const html = markup(react.createElement(SmoothStreamCard, props({})))
  assert.ok(html.includes('aria-expanded="false"'), 'the card starts collapsed')
  assert.ok(html.includes(COPY.title) && html.includes(COPY.description), 'the header carries title and one-liner')
  const versionLabel = COPY.developmentVersion.replace('{version}', SNAPSHOT.version)
  assert.ok(html.includes(versionLabel), `the header keeps the version badge ("${versionLabel}")`)
  assert.ok(!html.includes(COPY.enabled), 'the body stays closed until the header is clicked')
})

check('the page face and the card face do not share the card chrome', () => {
  const card = markup(react.createElement(SmoothStreamCard, props({})))
  const page = markup(react.createElement(SmoothStreamPluginsPage, props({ view: 'page' })))
  assert.notEqual(rootClass(card), rootClass(page), 'the page root sheds the card surface class')
  assert.ok(!rootClass(page).includes(rootClass(card)), 'the card class is not reused on the page')
})

check('the page face binds the same staged state as the card', () => {
  const staged = markup(react.createElement(SmoothStreamPluginsPage, props({ view: 'page' })))
  const clean = markup(react.createElement(SmoothStreamPluginsPage, {
    ...face(),
    useSmoothStreamCard: (selector) => selector({ ...SNAPSHOT, dirty: false }),
    t,
    view: 'page',
  }))
  assert.ok(!/disabled[^>]*>保存/.test(staged), 'save is live while an edit is staged')
  assert.ok(!/disabled[^>]*>放弃修改/.test(staged), 'discard is live while an edit is staged')
  assert.ok(/disabled[^>]*>保存/.test(clean), 'save is dead with nothing staged')
  assert.ok(/disabled[^>]*>放弃修改/.test(clean), 'discard follows the staged state too')
})

console.log(`\n${checks} checks passed`)
