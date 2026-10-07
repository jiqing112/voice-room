// 修正 patch-bgm-ui 的唱片按钮锚点
import fs from 'node:fs'
const p = 'scripts/patch-bgm-ui.mjs'
let s = fs.readFileSync(p, 'utf8')
const before = "const oldBtnOnclick = `onclick={() => (controller?.bgmActive ? controller.stopBgm() : bgmFileInput?.click())}`"
const after = "const oldBtnOnclick = `onclick={() => bgmFileInput?.click()}`"
if (!s.includes(before)) { console.error('NOT FOUND'); process.exit(1) }
s = s.replace(before, after)
fs.writeFileSync(p, s)
console.log('onclick anchor fixed')
