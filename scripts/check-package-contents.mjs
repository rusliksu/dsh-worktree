import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const npmCache = join(process.cwd(), ".npm-cache")
await mkdir(npmCache, { recursive: true })
// npm.cmd needs a shell; invoke its JavaScript entry directly on Windows.
const command = process.platform === "win32" ? process.execPath : "npm"
const args = process.platform === "win32"
  ? [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), "pack", "--dry-run", "--json"]
  : ["pack", "--dry-run", "--json"]
const { stdout } = await execFileAsync(command, args, {
  encoding: "utf8",
  env: { ...process.env, npm_config_cache: npmCache },
})
const result = JSON.parse(stdout)
assert.equal(result.length, 1, "npm pack must produce one package manifest")

const files = result[0].files.map(({ path }) => path).sort()
const expected = ["LICENSE", "README.md", "README.ru.md", "README.zh.md", "client/client.js", "cordis.patch.yml", "docs/preview.png", "lib/index.js", "package.json"].sort()
assert.deepEqual(files, expected, "npm package contents changed; update the allowlist deliberately")
assert.equal(result[0].entryCount, expected.length, "npm package entry count must match the allowlist")
assert.ok(result[0].size > 0, "npm package must contain bytes")

console.log(`npm package contents are valid (${files.length} files, ${result[0].size} bytes)`)
