// 缩短 patch-bgm 的字段锚点（注释行易有差异，只用字段行做锚）
import fs from 'node:fs'
const p = 'scripts/patch-bgm.mjs'
let s = fs.readFileSync(p, 'utf8')
const marker = 'const oldFields = `'
const i = s.indexOf(marker)
if (i < 0) { console.error('marker not found'); process.exit(1) }
const bgmLine = s.indexOf('	bgmActive = $state(false);', i)
if (bgmLine < 0) { console.error('bgm line not found'); process.exit(1) }
s = s.slice(0, i + marker.length) + s.slice(bgmLine)
fs.writeFileSync(p, s)
console.log('anchor shortened to fields only')
