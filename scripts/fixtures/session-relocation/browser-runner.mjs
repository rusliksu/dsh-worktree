import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { prepareCold } from './prepare-cold.mjs'
const { chromium } = await import(pathToFileURL(process.env.RELOCATION_PLAYWRIGHT).href)
const base = process.env.RELOCATION_OUTPUT
const home = process.env.RELOCATION_HOME ?? base + '/home', profile = home + '/profiles/' + (process.env.RELOCATION_PROFILE ?? 'web')
const root = process.argv[2] ?? base + '/delivery-runs/' + randomUUID()
const phase = process.argv[3] ?? 'roundtrip'
if (!root.startsWith(base + '/delivery-runs/') || !['roundtrip', 'prepare', 'verify'].includes(phase)) throw Error('Invalid isolated proof inputs')
await mkdir(root, { recursive: true })
await cp(new URL('./browser-fixture.mjs', import.meta.url), profile + '/delivery-browser-fixture.mjs')
await writeFile(profile + '/cordis.patch.yml', `- id: webserver
  config:
    host: 127.0.0.1
    port: 0
- id: session-persistence-jsonl
  config:
    root: ${root}/sessions
    compression: none
- id: agent-loop
  config:
    agents: []
- id: agent-default-model
  config:
    provider: relocation-proof
    model: no-stream
- id: ui-settings-general
  config:
    welcomeNoticeVersion: 2026-09-28.1
- insert:
    - id: delivery-browser-fixture
      name: ${profile}/delivery-browser-fixture.mjs
`)
const resources = process.env.RELOCATION_RESOURCES, runtime = resources + '/app.asar/dsh'
if (process.env.RELOCATION_COLD === '1') await prepareCold(profile)
const child = spawn(process.env.RELOCATION_EXECUTABLE, ['--expose-internals', runtime + '/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js', runtime, profile, resources + '/runtime/primary-runtime', resources + '/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs', resources + '/runtime/bin'], {
  cwd: profile, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_CLIENT_VERSION: '0.2.1-rc.2', DSH_DELIVERY_PROOF: root, DSH_BROWSER_PHASE: phase },
})
let fatal = false, tail = '', browser, page
child.stdout.on('data', data => { tail = (tail + data).slice(-16000) })
child.stderr.on('data', data => { tail = (tail + data).slice(-16000) })
const waitMessage = type => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', listener); reject(Error('Timed out waiting for ' + type)) }, 45000)
  function listener(message) {
    if (message.type === 'fatal' || message.type === 'proof-error') { clearTimeout(timer); child.off('message', listener); reject(Error(message.message)) }
    if (message.type === type) { clearTimeout(timer); child.off('message', listener); resolve(message) }
  }
  child.on('message', listener)
})
const hostExit = new Promise(resolve => child.on('exit', code => resolve(code)))
child.on('message', message => { if (message.type === 'fatal') fatal = true })
const ready = waitMessage('ready'), fixture = waitMessage('proof-fixture')
const report = { status: 'running', checks: [], root, phase }
child.on('message', message => { if (message.type === 'proof-native-refusal') report.nativeRefusal = { code: message.code, message: message.message } })
child.on('message', message => { if (message.type === 'proof-owner-event') (report.ownerEvents ??= []).push(message.event) })
const consoleErrors = []
try {
  const [host, { facts }] = await Promise.all([ready, fixture])
  browser = await chromium.launch({ headless: true, ...(process.env.RELOCATION_BROWSER ? { executablePath: process.env.RELOCATION_BROWSER } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' })
  page = await context.newPage()
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().replace(/https?:\/\/\S+/g, '[URL]')) })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  // The authenticated URL comes only from this fresh owned Host IPC, and is never logged or persisted.
  await page.goto(host.url, { waitUntil: 'load' })
  const row = page.getByRole('treeitem').filter({ has: page.getByText(facts.title, { exact: true }) })
  await Promise.race([page.getByRole('tree', { name: 'Sessions', exact: true }).waitFor({ timeout: 30000 }), page.getByText('Failed to load plugins', { exact: false }).waitFor().then(() => { throw Error('Client plugin boot failed') })])
  const notice = page.getByRole('dialog', { name: 'Preview Notice' })
  if (await notice.waitFor({ timeout: 5000 }).then(() => true, () => false)) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
  if (phase === 'verify' && await row.count() === 0) {
    const group = page.getByRole('treeitem', { name: 'b', exact: true }).first()
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  }
  await row.waitFor()
  await row.click()
  await page.getByText('RELOCATION_HISTORY_MARKER', { exact: false }).waitFor()
  const composer = page.locator('[data-composer-input][contenteditable="true"]')
  await composer.waitFor()
  await composer.fill('UNSENT_RELOCATION_DRAFT — keep exactly')
  const openMove = async () => {
    await row.hover()
    await row.getByRole('button', { name: `Session actions for ${facts.title}` }).click()
    await page.getByRole('menuitem', { name: 'Move chat', exact: true }).click()
  }
  const inspect = async () => {
    const answer = waitMessage('proof-inspection')
    child.send({ type: 'proof-inspect', requestId: randomUUID() })
    return answer
  }
  if (phase === 'verify') {
    const restarted = await inspect()
    assert.equal(restarted.info.cwd, facts.b); assert.equal(restarted.copies, 1); assert.equal(restarted.prefixPreserved, true)
    report.checks.push('fresh installed Host and browser resume same ID in B with original history')
  }
  await openMove()
  const dialog = page.getByRole('dialog', { name: 'Move chat', exact: true })
  if (phase !== 'verify') {
  await dialog.getByRole('combobox', { name: 'Destination project' }).selectOption(facts.wb)
  await writeFile(root + '/dialog-aria.txt', await page.locator('body').ariaSnapshot())
  await page.screenshot({ path: root + '/dialog.png' })
  report.checks.push('actual installed browser boot and existing session visible')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal((await inspect()).info.cwd, facts.a)
  assert.equal(await composer.textContent(), 'UNSENT_RELOCATION_DRAFT — keep exactly')
  report.checks.push('cancel leaves placement and plain draft unchanged')
  await openMove()
  await dialog.getByRole('combobox', { name: 'Destination project' }).selectOption(facts.wb)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: root + '/dialog-mobile.png' })
  assert.ok(await dialog.evaluate(el => el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().left >= 0))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await dialog.getByRole('button', { name: 'Move', exact: true }).click()
  await page.locator('.dswt-dialog-content').waitFor({ state: 'detached', timeout: 20000 })
  await page.getByText('RELOCATION_HISTORY_MARKER', { exact: false }).waitFor()
  assert.equal(await composer.textContent(), 'UNSENT_RELOCATION_DRAFT — keep exactly')
  assert.equal(await row.count(), 1)
  const moved = await inspect()
  assert.equal(moved.info.cwd, facts.b); assert.equal(moved.copies, 1); assert.equal(moved.modelCalls, 0); assert.equal(moved.prefixPreserved, true)
  report.checks.push('real UI A to B keeps same ID, history, single identity and unsent draft; no model calls')
  await writeFile(root + '/moved-aria.txt', await page.locator('body').ariaSnapshot())
  await page.screenshot({ path: root + '/moved.png' })
  }
  if (phase !== 'prepare') {
  if (phase !== 'verify') await openMove()
  await dialog.getByRole('combobox', { name: 'Destination project' }).selectOption(facts.wa)
  await dialog.getByRole('button', { name: 'Move', exact: true }).click()
  await page.locator('.dswt-dialog-content').waitFor({ state: 'detached', timeout: 20000 })
  assert.equal(await composer.textContent(), 'UNSENT_RELOCATION_DRAFT — keep exactly')
  const returned = await inspect()
  assert.equal(returned.info.cwd, facts.a); assert.equal(returned.copies, 1); assert.equal(returned.modelCalls, 0); assert.equal(returned.prefixPreserved, true)
  report.checks.push('real UI B to A retains draft and exact history prefix')
  }
  report.status = 'passed'
  report.pageErrors = errors
} catch (error) {
  report.status = 'failed'; report.error = error.message.replace(/https?:\/\/\S+/g, '[URL]')
  if (page) report.bootModules = await page.evaluate(() => (window.__DSH_BOOT__?.entries ?? []).map(({ id, inject, external, immediately }) => ({ id, inject, external, immediately }))).catch(() => [])
  if (page) { await writeFile(root + '/failure-aria.txt', await page.locator('body').ariaSnapshot().catch(() => 'unavailable')); await page.screenshot({ path: root + '/failure.png' }).catch(() => {}) }
  process.exitCode = 1
} finally {
  await browser?.close()
  if (child.connected) child.send({ type: 'shutdown' })
  report.hostExit = await hostExit; report.fatal = fatal
  report.consoleErrors = consoleErrors
  if (report.hostExit !== 0 || fatal) process.exitCode = 1
  await writeFile(root + '/browser-report-' + phase + '.json', JSON.stringify(report, null, 2) + '\n')
  await writeFile(root + '/host-diagnostic.txt', tail.split(/\r?\n/).filter(line => !/token|authorization|credential|secret|bearer/i.test(line)).join('\n'))
  console.log(JSON.stringify(report))
}
