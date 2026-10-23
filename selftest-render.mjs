/**
 * selftest-render.mjs —— 设置页「白屏」回归测试（2026-10-22 老大报的那次）
 * ---------------------------------------------------------------------------
 * 病根：Panel 里 `const [needLogin] = useState(false)` 声明在某个 useEffect **之后**，
 *       而那个 useEffect 的依赖数组里就写了 needLogin ⇒ 渲染时踩 TDZ：
 *       ReferenceError: Cannot access 'needLogin' before initialization ⇒ 整页空白。
 *       `node --check` 查不出来（语法完全合法），只有真跑一遍渲染才炸。
 *
 * 这个脚本用「假 React」把 client.js 的 Panel 真跑一次：
 *   1. 模块自注册、注册到 settings.section —— 验接线
 *   2. Panel() 真渲染 —— 验不抛错（这就是白屏的判据）
 *   3. 静态扫 Panel 体内「先用后声明」—— 把同类 TDZ 提前抓住
 *      （先洗掉字符串/注释，只认真正的变量引用；`x.needLogin` 这种属性访问不算）
 *
 * 跑法： node selftest-render.mjs
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

/* ---------- 1. 用假宿主把 client bundle 跑起来 ---------- */
let mod = null
const fakeWindow = { __ModuleLoader__: { load: (m) => { mod = m } } }
const fakeDocument = {
  createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }),
  head: { appendChild() {} },
}
const fakeLocation = { origin: 'http://127.0.0.1:1' }
const fakeNavigator = { clipboard: { writeText() {} } }

const fn = new Function('window', 'document', 'location', 'navigator', src)
fn(fakeWindow, fakeDocument, fakeLocation, fakeNavigator)
if (!mod) throw new Error('❌ 模块没自注册（window.__ModuleLoader__.load 没被调用）')

/* ---------- 2. 假 React + 抓注册 ---------- */
let captured = null
const fakeSlots = {
  inject(name, cb) { cb() },
  register(reg, comp) { captured = { reg, comp }; return reg },
}
const React = {
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (f) => f,
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (f) => f(),
}

const api = mod.factory((n) => { if (n === 'react') return React; throw new Error('未知模块 ' + n) })
api.apply({ effect: (f) => f, get: (k) => (k === 'slots' ? fakeSlots : undefined) })
if (!captured) throw new Error('❌ 没注册 settings.section')

const ok = []
ok.push(`模块 id = ${mod.id}`)
ok.push(`注册项 = ${captured.reg.name}/${captured.reg.id} order=${captured.reg.order} label=${captured.reg.label}`)

/* ---------- 3. 真渲染一次（白屏判据） ---------- */
let el
try {
  el = captured.comp().type()   // 注册的是 () => h(Panel)，取出来真调 Panel()
} catch (e) {
  console.error('❌ 设置页渲染抛错（这就是白屏）：')
  console.error(e && e.stack ? e.stack.split('\n').slice(0, 10).join('\n') : e)
  process.exit(1)
}
if (!el || !el.props || !('data-qz-page' in el.props)) {
  console.error('❌ 渲染出来的根节点不是 data-qz-page：', el)
  process.exit(1)
}
const secCount = (el.kids || []).filter((k) => k?.props && k.props['data-qz-sec'] !== undefined).length
ok.push(`渲染 OK：根节点 ${el.type}，区块数 ${secCount}`)

/* ---------- 4. 静态：Panel 体内 useState 变量不许在声明前被引用 ---------- */
// 先把字符串和注释洗成等长空白（保持位置不变），再扫。
const scrub = (s) => {
  const out = s.split('')
  let i = 0
  const blank = (a, b) => { for (let k = a; k < b; k += 1) if (out[k] !== '\n') out[k] = ' ' }
  while (i < s.length) {
    const c = s[i]
    const d = s[i + 1]
    if (c === '/' && d === '/') { const e = s.indexOf('\n', i); const end = e < 0 ? s.length : e; blank(i, end); i = end; continue }
    if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); const end = e < 0 ? s.length : e + 2; blank(i, end); i = end; continue }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue }
        if (s[j] === c) { j += 1; break }
        j += 1
      }
      blank(i + 1, j - 1)
      i = j
      continue
    }
    i += 1
  }
  return out.join('')
}

// 只取 Panel 函数体：从 `function Panel()` 起，按大括号配平到结束
const panelStart = src.indexOf('function Panel(')
if (panelStart < 0) throw new Error('❌ 找不到 function Panel(')
const bodyOpen = src.indexOf('{', panelStart)
let depth = 0
let panelEnd = -1
for (let i = bodyOpen; i < src.length; i += 1) {
  const ch = src[i]
  if (ch === '{') depth += 1
  else if (ch === '}') { depth -= 1; if (depth === 0) { panelEnd = i + 1; break } }
}
if (panelEnd < 0) throw new Error('❌ Panel 大括号没配平')
const panel = scrub(src.slice(bodyOpen, panelEnd))

const declRe = /const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*(set[A-Za-z_$][\w$]*)?\s*\]\s*=\s*React\.useState/g
const decls = []
let m
while ((m = declRe.exec(panel))) decls.push({ name: m[1], at: m.index })

let bad = 0
for (const d of decls) {
  const useRe = new RegExp(`(^|[^.\\w$])${d.name.replace(/\$/g, '\\$')}\\b`, 'g')
  let u
  while ((u = useRe.exec(panel))) {
    if (u.index < d.at) {
      console.error(`❌ TDZ 风险：${d.name} 在声明前被引用（引用位置 ${u.index} < 声明位置 ${d.at}）`)
      bad += 1
      break
    }
  }
}
if (bad) process.exit(1)
ok.push(`静态检查：${decls.length} 个 useState，没有「先用后声明」`)

console.log('✅ 全部通过')
for (const line of ok) console.log('   ' + line)
