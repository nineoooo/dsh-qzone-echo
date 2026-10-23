import { UA, cookieHeader, gtkOf } from './qzone.mjs'
import { parsePostJsonp } from './content.mjs'

export const uniquePictures = urls => [...new Set((Array.isArray(urls) ? urls : []).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)))]

export async function fetchPostPictures(jar, owner, tid, { timeout = 15000 } = {}) {
  const params = new URLSearchParams({ uin: String(owner), tid: String(tid), g_tk: gtkOf(jar), format: 'jsonp', callback: '_preloadCallback' })
  try {
    const res = await fetch('https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_get_pics_v6?' + params, {
      headers: { 'user-agent': UA, cookie: cookieHeader(jar), referer: 'https://user.qzone.qq.com/' + owner + '/main' },
      signal: AbortSignal.timeout(timeout),
    })
    const text = await res.text(), json = parsePostJsonp(text)
    const rawCode = json?.result?.code ?? json?.code
    const code = rawCode == null ? null : Number(rawCode)
    const message = String(json?.result?.msg || json?.message || '')
    if (res.ok && code === 0 && Array.isArray(json?.imageUrls)) {
      return { ok: true, urls: uniquePictures(json.imageUrls) }
    }
    return { ok: false, code, error: message || '图片详情暂不可用',
      throttled: res.status === 429 || /使用人数过多|频繁|稍后再试|waf\.tencent\.com/i.test(message + text.slice(0, 400)),
      needCookie: /login|登录/i.test(message) }
  } catch { return { ok: false, error: '补图请求超时或连接失败，请稍后重试' } }
}

// List responses can contain only the first nine images. Keep a verified full
// list when a later response is its preview, while allowing real image edits.
export function preserveCompletePictures(old, incoming) {
  const before = uniquePictures(old?.images), after = uniquePictures(incoming?.images)
  if ((old?.imageListComplete || old?.imageListPartial) && after.length && before.length > after.length
      && Number(incoming.picTotal) >= before.length && after.every(u => before.includes(u))) {
    return { ...incoming, images: before, imageListComplete: !!old.imageListComplete, imageListPartial: !!old.imageListPartial,
      imageListCheckedAt: old.imageListCheckedAt, picTotal: Math.max(Number(incoming.picTotal) || 0, before.length) }
  }
  if ((old?.imageListComplete || old?.imageListPartial) && JSON.stringify(before) !== JSON.stringify(after)) {
    return { ...incoming, imageListComplete: false, imageListPartial: false }
  }
  return incoming
}
