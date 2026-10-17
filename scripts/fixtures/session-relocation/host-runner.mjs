import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const base = process.env.RELOCATION_OUTPUT
const home = base + '/home'
const profile = home + '/profiles/web'
const original = process.argv[2] === 'original'
const invocation = randomUUID()
const root = process.argv[3] ?? base + '/delivery-runs/' + randomUUID()
if (!root.startsWith(base + '/delivery-runs/')) throw Error('proof root outside task directory')
await mkdir(root, { recursive: true })
const checkFile = original ? 'delivery-original-reader-check.mjs' : 'delivery-sdk-check.mjs'
const reportFile = original ? 'delivery-original-report.json' : 'delivery-sdk-report.json'
await cp(new URL(original ? './original-reader-check.mjs' : './sdk-check.mjs', import.meta.url), profile + '/' + checkFile)
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
    maxParallelToolCalls: 7
    agents: []
- id: ui-chat
  config:
    transcriptView: compact
    performanceUsage: compact
    linkOpening: new-tab
- insert:
    - id: delivery-sdk-proof
      name: ${profile}/${checkFile}
`)
const resources = process.env.RELOCATION_RESOURCES
const runtime = resources + '/app.asar/dsh'
const child = spawn(process.env.RELOCATION_EXECUTABLE, ['--expose-internals', runtime + '/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js', runtime, profile, resources + '/runtime/primary-runtime', resources + '/runtime/pnpm/bin/pnpm.mjs', resources + '/runtime/bin'], {
  cwd: profile, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_CLIENT_VERSION: '0.2.0-rc.2',
    DSH_DELIVERY_PROOF: root, DSH_DELIVERY_SOURCE: base + '/delivery-native-source.json', DSH_DELIVERY_INVOCATION: invocation },
})
let done = false, fatal = false, tail = ''
child.stdout.on('data', value => { tail = (tail + value).slice(-24000) })
child.stderr.on('data', value => { tail = (tail + value).slice(-16000) })
child.on('message', message => { if (message.type === 'fatal') { fatal = true; console.log(JSON.stringify({ hostFatal: true, message: message.message })) } })
const timer = setTimeout(() => { console.log(JSON.stringify({ timeout: true, root })); if (child.connected) child.send({ type: 'shutdown' }) }, 60000)
const poll = setInterval(async () => {
  try {
    const report = JSON.parse(await readFile(root + '/' + reportFile, 'utf8'))
    if (report.invocation !== invocation) return
    if (done) return
    done = true; clearInterval(poll); clearTimeout(timer)
    console.log(JSON.stringify({ ...report, root }))
    if (report.status !== 'passed') process.exitCode = 1
    if (child.connected) child.send({ type: 'shutdown' })
  } catch (error) { if (error.code !== 'ENOENT') console.log(error.message) }
}, 250)
child.on('exit', async code => {
  clearInterval(poll); clearTimeout(timer)
  await writeFile(root + '/host-result-' + (original ? 'original' : 'sdk') + '.json', JSON.stringify({ invocation, exitCode: code, proofWritten: done, fatal,
    diagnostic: tail.split(/\r?\n/).filter(line => !/token|authorization|credential|secret|bearer/i.test(line)).join('\n') }, null, 2) + '\n')
  console.log(JSON.stringify({ hostExit: code, proofWritten: done, root }))
  if (!done || code !== 0 || fatal) process.exitCode = 1
})
