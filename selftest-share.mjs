/**
 * 分享卡片（歌/视频/网页）解析自测 —— 不联网，纯造数据。
 * 关键：分享一条歌时，正文常常是空的，内容全在 source_* / rt_source_* / conlist 里。
 *
 * ⚠️ 2026-10-27：这个脚本原来只 console.log，没有一条断言 —— 那就是「打印，不算测试」，
 *    改了 normalize 把分享卡片解析改坏了也照样绿灯。现在补成硬断言。
 */
import assert from 'node:assert/strict'
import { normalize } from './lib/qzone.mjs'
import { classify } from './lib/classify.mjs'

const cases = [
  {
    label: '① 分享 QQ 音乐（正文空，appid=233）',
    raw: {
      tid: 'M1', content: '', created_time: 1700000000,
      source_appid: '233', source_name: '晴天', source_url: 'https://i.y.qq.com/n2/m/share/details/song.html?songmid=0039MnYb0qxYhV',
      conlist: [], pic: [], commentlist: [],
    },
    want: { share: true, music: true, kind: 'share', appid: '233', name: '晴天', urlIncludes: 'y.qq.com' },
  },
  {
    label: '② 分享网易云（靠域名认，没有 appid）',
    raw: {
      tid: 'M2', content: '这首歌好听', created_time: 1700000001,
      source_appid: '', source_name: '', source_url: 'https://music.163.com/song?id=1234567',
      conlist: [{ con: '这首歌好听', type: 2 }], pic: [], commentlist: [],
    },
    want: { share: true, music: true, urlIncludes: 'music.163.com' },
  },
  {
    label: '③ 普通说说（不能误判成分享）',
    raw: {
      tid: 'M3', content: '今天有点难过，想了想还是算了。', created_time: 1700000002,
      conlist: [{ con: '今天有点难过，想了想还是算了。', type: 2 }], pic: [], commentlist: [],
    },
    want: { share: false, music: false, kind: 'misc' },
  },
  {
    label: '④ 转发一条歌（卡片在 rt_* 上）',
    raw: {
      tid: 'M4', content: '转一首', created_time: 1700000003,
      rt_con: { content: '原主人的话', name: '某人', conlist: [] },
      rt_source_appid: '233', rt_source_name: '夜曲', rt_tid: 'X1',
      conlist: [{ con: '转一首', type: 2 }], pic: [], commentlist: [],
    },
    want: { share: true, music: true, kind: 'forward', appid: '233', name: '夜曲' },
  },
  {
    label: '⑤ 分享视频（非音乐 appid）',
    raw: {
      tid: 'M5', content: '', created_time: 1700000004,
      source_appid: '100497308', source_name: '某个视频', source_url: 'https://h5.qzone.qq.com/x',
      conlist: [], pic: [], commentlist: [],
    },
    want: { share: true, music: false, kind: 'share', appid: '100497308', name: '某个视频' },
  },
]

for (const c of cases) {
  const m = normalize(c.raw)
  const k = classify(m)
  const got = { share: m.share, music: m.music, kind: k.kind }
  const want = c.want
  if (want) {
    assert.equal(m.music, want.music, `${c.label}：music 应为 ${want.music}，实际 ${m.music}`)
    if (want.kind) assert.equal(k.kind, want.kind, `${c.label}：kind 应为 ${want.kind}，实际 ${k.kind}`)
    if (want.share === false) {
      assert.equal(m.share, null, `${c.label}：不该识别成分享卡片，实际 ${JSON.stringify(m.share)}`)
    } else if (want.share === true) {
      assert.ok(m.share && typeof m.share === 'object', `${c.label}：应该识别成分享卡片，实际 ${JSON.stringify(m.share)}`)
    }
    if (want.appid != null) assert.equal(m.share?.appid || '', want.appid, `${c.label}：appid 不对`)
    if (want.name != null) assert.equal(m.share?.name || '', want.name, `${c.label}：卡片名不对`)
    if (want.urlIncludes) assert.ok(String(m.share?.url || '').includes(want.urlIncludes), `${c.label}：卡片链接里应含 ${want.urlIncludes}`)
  }
  console.log(`${c.label}\n  share = ${JSON.stringify(m.share)}\n  music = ${m.music} | kind = ${k.kind} | score = ${k.score} | reasons = ${k.reasons.join(' / ')}\n`)
}
console.log(`✅ 分享卡片解析 ${cases.length} 例全部通过`)
