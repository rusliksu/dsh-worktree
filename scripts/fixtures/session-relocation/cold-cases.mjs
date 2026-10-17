/** Actual installed composition/parser and guard, with only synthetic profile metadata. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const base = process.env.RELOCATION_OUTPUT, profile = base + '/home/profiles/web'
const { prepareProfile, apply, splitPreparation } = await import(pathToFileURL(process.argv[2] ?? profile + '/node_modules/@alpacachen/dsh-simple-worktree/native/lib/relocation-cold.js').href)
const context = { dir: profile, home: base + '/home', installAnchor: process.env.RELOCATION_RESOURCES + '/app.asar/dsh/package.json', overlays: [] }
const { createRequire } = await import('node:module')
const req = createRequire(context.installAnchor)
const yaml = await import(pathToFileURL(req.resolve('js-yaml')).href)
const { entryListSchema } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis-plugin-include')).href)
const files = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']
const original = new Map(await Promise.all(files.map(async name => [name, await readFile(profile + '/' + name, 'utf8')])))
const manifest = JSON.parse(original.get('package.json'))
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== '@deepseek-ai/dsh-experimental-schedule-bundle')
const results = []
const cases = [
  ['absent', []],
  ['enabled', [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule', config: { deliveryHistoryDays: 17, deliveryHistoryRecords: 23 } }]],
  ['disabled', [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule', disabled: true }]],
  ['expression false', [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule', disabled: { __jsExpr: 'false' } }]],
  ['expression true', [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule', disabled: { __jsExpr: 'true' } }]],
  ['disabled parent', [{ id: 'schedule-parent', name: 'cordis:group', group: true, disabled: true, config: [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule', config: { deliveryHistoryDays: 17 } }] }]],
]
try {
  await writeFile(profile + '/package.json', JSON.stringify(manifest, null, 2) + '\n')
  for (const [name, rows] of cases) {
    await writeFile(profile + '/cordis.patch.yml', yaml.dump(rows.length ? [{ insert: rows }] : [], { schema: entryListSchema, noRefs: true }))
    await assert.rejects(prepareProfile(context), /fully close/)
    const outcome = await prepareProfile(context, { closed: true })
    const parts = splitPreparation(await readFile(profile + '/cordis.patch.yml', 'utf8'))
    const suffix = yaml.load(parts.generated, { schema: entryListSchema })
    const guard = suffix[0].insert[0].config
    const listeners = new Map()
    const ctx = { profileContext: context, on: (event, handler) => listeners.set(event, handler), provide: (key, value) => assert.equal(value.fingerprint, outcome.fingerprint) }
    await apply(ctx, guard)
    await listeners.get('agent/relocation-check')()
    if (rows.length) {
      const source = rows[0].group ? rows[0].config[0] : rows[0]
      const replacement = suffix.at(-1).insert[0]
      assert.deepEqual(replacement.config, source.config)
      assert.deepEqual(replacement.disabled, source.disabled)
      assert.equal(suffix.at(-1).id, rows[0].group ? rows[0].id : undefined)
    } else assert.equal(suffix.length, 2)
    await writeFile(profile + '/pnpm-lock.yaml', original.get('pnpm-lock.yaml') + '\n# changed source\n')
    await assert.rejects(listeners.get('agent/relocation-check')(), /configuration changed/)
    await writeFile(profile + '/pnpm-lock.yaml', original.get('pnpm-lock.yaml'))
    listeners.get('loader/partial-dispose')({ options: { id: 'webserver' } }, {}, true)
    await listeners.get('agent/relocation-check')()
    const same = { id: 'dsh-relocation-global-schedule', name: 'same-implementation', config: { deliveryHistoryDays: 17 } }
    listeners.get('loader/partial-dispose')({ options: same }, structuredClone(same), true)
    await listeners.get('agent/relocation-check')()
    listeners.get('loader/partial-dispose')({ options: { ...same, name: 'different-implementation' } }, same, true)
    await assert.rejects(listeners.get('agent/relocation-check')(), /hot Schedule replacement/)
    let appended = []
    if (name === 'enabled') {
      appended = [{ id: 'agent-default-model', config: { provider: 'synthetic-provider', model: 'synthetic-model' } }, { id: 'ui-settings-general', config: { welcomeNoticeVersion: 'synthetic-version' } }]
      const current = await readFile(profile + '/cordis.patch.yml', 'utf8')
      await writeFile(profile + '/cordis.patch.yml', current.replace('# dsh-relocation-cold:end\n', yaml.dump(appended, { schema: entryListSchema }) + '# dsh-relocation-cold:end\n'))
      const freshListeners = new Map()
      await assert.rejects(apply({ ...ctx, on: (event, handler) => freshListeners.set(event, handler) }, guard), /configuration changed/)
      await prepareProfile(context, { closed: true })
      results.push('ordinary model/general overrides appended by DSH survive re-preparation and removal')
    }
    await prepareProfile(context, { closed: true, remove: true })
    assert.deepEqual(yaml.load(await readFile(profile + '/cordis.patch.yml', 'utf8'), { schema: entryListSchema }) ?? [], [...(rows.length ? [{ insert: rows }] : []), ...appended])
    results.push(name + ': preserved, guarded, rollback verified')
  }
  for (const rows of [
    [{ id: 'schedule', name: '@foreign/provider' }],
    [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule' }, { id: 'other', name: '@deepseek-ai/dsh-schedule' }],
    [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule', isolate: { schedule: true } }],
    [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule', intercept: { schedule: true } }],
  ]) {
    const text = yaml.dump([{ insert: rows }], { schema: entryListSchema })
    await writeFile(profile + '/cordis.patch.yml', text)
    await assert.rejects(prepareProfile(context, { closed: true }), /foreign|ambiguous|scope/)
    assert.equal(await readFile(profile + '/cordis.patch.yml', 'utf8'), text)
  }
  results.push('foreign, duplicate, isolate, intercept refused before write')
  await writeFile(base + '/cold-cases-report.json', JSON.stringify({ status: 'passed', results }, null, 2) + '\n')
  console.log(JSON.stringify({ coldCases: 'passed', count: cases.length + 4 }))
} finally {
  for (const [file, contents] of original) await writeFile(profile + '/' + file, contents)
}
