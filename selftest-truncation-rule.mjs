import assert from 'node:assert/strict'
import { looksTruncated, renderedLength, TRUNC_LIMIT } from './lib/content.mjs'

// ① 明说还有更多 → 一定查
assert.equal(looksTruncated({ content: '短', contentIncomplete: true }), true)
// ② 卡在 500 上限 → 查
assert.equal(looksTruncated({ content: '甲'.repeat(TRUNC_LIMIT) }), true)
assert.equal(looksTruncated({ content: '甲'.repeat(TRUNC_LIMIT - 10) }), true)
// ③ 断在半句的长文 → 查（腾讯按字节截，447 字那条实测被切在「那时候感觉开」）
assert.equal(looksTruncated({ content: '甲'.repeat(440) + '那时候感觉开' }), true)
// ④ 长文但句末有标点 → 不查
assert.equal(looksTruncated({ content: '甲'.repeat(440) + '。' }), false)
// ⑤ 长文以省略号收尾 → 查（以前 200 门槛，现在统一 300）
assert.equal(looksTruncated({ content: '甲'.repeat(300) + '……' }), true)
assert.equal(looksTruncated({ content: '甲'.repeat(120) + '……' }), false)
// ⑥ 短帖无论怎么收尾都不查
assert.equal(looksTruncated({ content: '今天好累' }), false)
assert.equal(looksTruncated({ content: '累累……累累……' }), false)
// ⑦ 详情已确认完整 → 再长也不查（否则会无限重排）
assert.equal(looksTruncated({ content: '甲'.repeat(2000), contentSource: 'detail', contentIncomplete: false }), false)
// ⑧ 列表接口的中文长文断在半句 → 照样要查（换行/英文会提前截）
assert.equal(looksTruncated({ content: '第一行\n第二行很长很长' + '甲'.repeat(300) + '突然断', contentSource: 'list', contentIncomplete: false }), true)
// ⑨ 英文/数字收尾视为说完了
assert.equal(looksTruncated({ content: '甲'.repeat(400) + 'end' }), false)
// ⑩ 表情码收尾视为说完
assert.equal(looksTruncated({ content: '甲'.repeat(400) + '[em]e188[/em]' }), false)
// 表情码算 1 个字（跟腾讯同一把尺子）
assert.equal(renderedLength('[em]e188[/em][em]e189[/em]'), 2)
console.log('PASS: 判据 ①明说截断 ②卡500上限 ③断在半句 ④正常收尾不查 ⑤省略号 ⑥短帖豁免 ⑦详情已确认豁免 ⑧列表也要查 ⑨英文收尾 ⑩表情码')
