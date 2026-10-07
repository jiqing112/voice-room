// 标签配对平衡检查
import fs from 'node:fs'
const s = fs.readFileSync('src/routes/room/[name]/+page.svelte', 'utf8')
for (const tag of ['div', 'section', 'footer', 'form', 'button', 'p', 'span', 'main', 'header', 'input', 'audio']) {
  const openRe = new RegExp('<' + tag + '(\\s|>)', 'g')
  const closeRe = new RegExp('</' + tag + '>', 'g')
  const selfRe = new RegExp('<' + tag + '[^>]*/>', 'g')
  const open = (s.match(openRe) || []).length
  const close = (s.match(closeRe) || []).length
  const selfClose = (s.match(selfRe) || []).length
  if (open - selfClose !== close) {
    console.log(tag, 'open', open, 'selfclose', selfClose, 'close', close, '→ 不平衡')
  }
}
console.log('balance check done')
