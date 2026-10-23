/**
 * 网页版：一个自包含的页面（不开新服务、不占端口）
 * ----------------------------------------------------------------------------
 * 为什么这么做：
 *   1. 宿主本来就有 webServer，插件挂个前缀就能吐 HTML —— 再起个 3000 端口
 *      属于自己给自己找麻烦（端口冲突、还要单独管进程）。
 *   2. 页面只读 `$DSH_HOME/qzone-echo/` 里的 jsonl，不碰网络、不碰 Cookie。
 *   3. 图和表情都走同源 `/img`、`qzonestyle` CDN，不用额外代理。
 *   4. HTML 单独放 `lib/page.html`：塞进 JS 模板字符串里要处理反引号和 `${`，
 *      踩过一次（2026-10-22 语法报错），干脆分文件，编辑也方便。
 *
 * ⚠️ 缓存按 mtime 判：ESM 模块实例在插件热重载后**可能被复用**，老版本无条件缓存
 *    导致改了 page.html 页面还在吐旧内容（2026-10-22 实测 16304 → 仍回 13180）。
 *    现在每次请求 stat 一下，文件变了就重读 —— stat 的开销可以忽略。
 *
 * 数据接口（同源，都在 index.js 里）：
 *   GET  /items?scope=&limit=&offset=&year=&q=
 *   GET  /status   GET /lock
 *   POST /login  /unlock  /lock  /randompass
 *   POST /fix      { tid, thought } | { tid, undo:true } | { undoAll:true }
 *   POST /export   { format:'md'|'json', scope }
 */
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PAGE_FILE = join(here, 'page.html')

let cache = null
let stamp = 0

/** 读页面 HTML。改了 page.html 会自动生效，不用重载插件。 */
export function page() {
  let m = 0
  try { m = statSync(PAGE_FILE).mtimeMs } catch { return '<!doctype html><meta charset="utf-8"><p>page.html 不见了' }
  if (cache && m === stamp) return cache
  cache = readFileSync(PAGE_FILE, 'utf8')
  stamp = m
  return cache
}

/** 测试用：丢掉缓存，下次重新读盘 */
export function resetPageCache() { cache = null; stamp = 0 }
