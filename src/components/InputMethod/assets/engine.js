/******************************************************************************
 * @file        engine.js
 * @description 中文输入法引擎，支持常用词输入（精简版）
 * @author      B4QAQ
 * @source      ResonaUI
 * @version     1.3
 * @copyright   2026 B4QAQ@MCNS.
 * @license     MPL-2.0-only
 *
 * 相对 1.1 的变化（行为不变，只减体积）：
 *   1. 偏移表改为「每块长度」的 2 字符 base36 串，运行时展开成 Uint16Array。
 *      两张表各 405 个数字 -> 810 字符，省掉约 2.4 KB 包体，且内存更小。
 *      传入数组（旧格式）也能用，自动识别。
 *   2. 移除未接入的简拼（attachAbbr）。
 *   3. 词组按需加载：attachPhraseLoader(fn)。
 *      fn(gid) 返回 Promise<{data, len, lo, hi}>；data 为该首字母下的词组块，
 *      len 为「每块长度」的 2 字符 base36 串，[lo,hi] 为该字母的音节 id 区间。
 *      宿主用 @system.file 的 readText 读包内 .txt，JSON.parse 后交给引擎。
 *      失败（无文件接口 / 读取失败）时退化成纯单字输入，不影响使用。
 ******************************************************************************/
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'
const V36 = {}
for (let i = 0; i < 36; i++) V36[B36[i]] = i

function buildOffsets(x) {
  if (typeof x !== 'string') return x
  const n = x.length >> 1
  const off = new Uint16Array(n + 1)
  let acc = 0
  for (let i = 0; i < n; i++) {
    off[i] = acc
    acc += V36[x[i * 2]] * 36 + V36[x[i * 2 + 1]]
  }
  off[n] = acc
  return off
}

export function createIME(core) {
  const CHARS = core.CHARS
  const COFF = buildOffsets(core.CLEN || core.COFF)
  const SYLS = core.SYLS

  // 音节表保持「一根字符串 + 偏移表」，不拆成 404 个字符串
  // （拆开后 V8 上要多占约 10 KB，且不建 404 项的 Map，改用二分查找）
  const NS = COFF.length - 1
  const SOFF = new Uint16Array(NS)
  {
    let k = 0
    for (let i = 0, p = 0; i < NS; i++) {
      SOFF[i] = p
      const bar = SYLS.indexOf('|', p)
      p = (bar < 0 ? SYLS.length : bar) + 1
    }
  }
  const sylLen = i => ((i + 1 < NS ? SOFF[i + 1] - 1 : SYLS.length) - SOFF[i])
  const sylStr = i => SYLS.substr(SOFF[i], sylLen(i))

  // 频序打分存成 Uint8（分值 ×16 取整），省掉 404 个 double
  const SSCORE = new Uint8Array(NS)
  let maxSylLen = 0
  for (let i = 0; i < NS; i++) {
    const L = sylLen(i)
    if (L > maxSylLen) maxSylLen = L
    SSCORE[i] = Math.round(Math.log2((COFF[i + 1] - COFF[i]) + 1) * 16)
  }
  const sylScore = i => SSCORE[i]

  // 二分查找，逐字符比较，不产生临时字符串
  function sylId(s) {
    let lo = 0, hi = NS - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const off = SOFF[mid], n = sylLen(mid)
      let d = 0
      for (let i = 0; i < n; i++) {
        const a = SYLS.charCodeAt(off + i), b = i < s.length ? s.charCodeAt(i) : 0
        if (a !== b) { d = a < b ? -1 : 1; break }
      }
      if (d === 0 && s.length > n) d = -1
      if (d === 0) return mid
      if (d < 0) lo = mid + 1; else hi = mid - 1
    }
    return -1
  }
  const charAt = (id, rank) => CHARS[COFF[id] + rank]

  // 同一首字母的音节在排序表里是连续区间 —— 分片只需文件名里的字母，
  // 不用在分片里带 IDS 数组。区间存进两个 26 长的 Uint16Array（按 charCode-97
  // 索引），比 23 个小数组省得多。
  const LO = new Uint16Array(26), HI = new Uint16Array(26), SEEN = new Uint8Array(26)
  for (let i = 0; i < NS; i++) {
    const k = SYLS.charCodeAt(SOFF[i]) - 97
    if (k < 0 || k >= 26) continue
    if (!SEEN[k]) { SEEN[k] = 1; LO[k] = i }
    HI[k] = i
  }

  let PHRASE = '', POFF = null
  function attachPhrase(str, off) { PHRASE = str; POFF = buildOffsets(off) }

  /* ---- 词组按需加载：由宿主从包内 .txt 读入分片 ---- */
  let loader = null
  const pending = new Map()   // gid -> Promise
  const shards = new Map()    // gid -> { data, off, lo }
  function attachPhraseLoader(fn) { loader = fn }

  function ensureGroup(gid) {
    if (POFF || shards.has(gid)) return Promise.resolve(true)
    if (!loader) return Promise.resolve(false)
    if (pending.has(gid)) return pending.get(gid)
    const pr = (async () => {
      let r = null
      try { r = await loader(gid) } catch (e) { r = null }
      if (!r || !r.data) return false
      const rec = { data: r.data, off: buildOffsets(r.len), lo: r.lo, hi: r.hi }
      for (let g = r.lo; g <= r.hi; g++) shards.set(g, rec)
      return true
    })()
    pending.set(gid, pr)
    return pr
  }

  function blockOf(gid) {
    if (POFF) return { s: PHRASE, a: POFF[gid], b: POFF[gid + 1] }
    const r = shards.get(gid)
    if (!r) return null
    const k = gid - r.lo
    return { s: r.data, a: r.off[k], b: r.off[k + 1] }
  }

  function scanGroup(gid, target, len, lastPrefix, cap) {
    const blk = blockOf(gid)
    if (!blk) return []
    const s = blk.s
    const start = blk.a, end = blk.b
    if (start === undefined || start >= end) return []
    let p = start
    const alphaLen = V36[s[p]] * 36 + V36[s[p + 1]]; p += 2
    const alpha = []
    if (alphaLen > 0) for (let i = 0; i < alphaLen; i++) { alpha.push(V36[s[p]] * 36 + V36[s[p + 1]]); p += 2 }
    const tn = target.length
    const cur = [gid]
    const out = []
    while (p < end) {
      const h = V36[s[p++]]
      const shared = ((h / 4) | 0) + 1
      const nNew = h % 4
      cur.length = shared
      for (let i = 0; i < nNew; i++) {
        if (alphaLen === 0) { cur.push(V36[s[p]] * 36 + V36[s[p + 1]]); p += 2 }
        else if (s[p] === 'z') { cur.push(V36[s[p + 1]] * 36 + V36[s[p + 2]]); p += 3 }
        else { cur.push(alpha[V36[s[p]]]); p++ }
      }
      const n = cur.length
      let hit = (n === len && tn <= n)
      if (hit) {
        const eN = (lastPrefix && len === tn) ? tn - 1 : Math.min(tn, len)
        for (let i = 0; i < eN; i++) if (cur[i] !== target[i]) { hit = false; break }
        if (hit && lastPrefix && len > eN && sylStr(cur[len - 1]).indexOf(lastPrefix) !== 0) hit = false
      }
      if (hit) {
        let w = '', score = 0
        for (let i = 0; i < n; i++) {
          let r
          if (s[p] === 'z') { r = V36[s[p + 1]] * 36 + V36[s[p + 2]]; p += 3 }
          else { r = V36[s[p]]; p++ }
          score += r
          w += CHARS[COFF[cur[i]] + r]
        }
        out.push({ w, score })
        if (out.length >= cap) break
      } else {
        for (let i = 0; i < n; i++) p += (s[p] === 'z' ? 3 : 1)
      }
    }
    return out
  }

  // top-K 动态规划切分：单一启发式必错一半（fangan=fan|gan，chuanganqi=chuan|gan|qi）
  function dpTopK(seg, K) {
    const n = seg.length
    const best = new Array(n + 1).fill(null)
    best[0] = [{ count: 0, score: 0, prev: -1, prevRank: -1, id: -1, cut: 0 }]
    for (let i = 0; i < n; i++) {
      if (!best[i]) continue
      for (let L = 1; L <= Math.min(maxSylLen, n - i); L++) {
        const id = sylId(seg.substr(i, L))
        if (id < 0) continue
        const j = i + L
        const cur = best[j] || (best[j] = [])
        for (let r = 0; r < best[i].length; r++) {
          const b = best[i][r]
          cur.push({ count: b.count + 1, score: b.score + sylScore[id], prev: i, prevRank: r, id, cut: j })
        }
        cur.sort((x, y) => (x.count - y.count) || (y.score - x.score))
        if (cur.length > K) cur.length = K
      }
    }
    return best
  }

  function traceTopK(best, end, K) {
    if (!best[end] || !best[end].length) return []
    const out = []
    for (let r = 0; r < Math.min(K, best[end].length); r++) {
      const ids = [], cuts = []
      let pos = end, rank = r, guard = 0
      while (pos > 0 && guard++ < 64) {
        const b = best[pos][rank]
        if (!b) break
        ids.push(b.id); cuts.push(b.cut)
        pos = b.prev; rank = b.prevRank
      }
      if (pos === 0) out.push({ ids: ids.reverse(), cuts: cuts.reverse() })
    }
    return out
  }

  function startingWith(prefix) {
    const r = []
    for (let i = 0; i < NS; i++) if (sylStr(i).indexOf(prefix) === 0) r.push(i)
    return r
  }

  function segment(py, K = 3) {
    py = (py || '').toLowerCase().replace(/[^a-z']/g, '')
    if (!py) return { ids: [], seg: [], partial: '', alts: [], cuts: [] }
    if (py.indexOf("'") >= 0) {
      const parts = py.split("'").filter(Boolean)
      const ids = [], cuts = []
      let off = 0
      for (const seg of parts) {
        const t = traceTopK(dpTopK(seg, 1), seg.length, 1)[0]
        if (!t) return { ids: [], seg: [], partial: py, alts: [], cuts: [] }
        for (let i = 0; i < t.ids.length; i++) { ids.push(t.ids[i]); cuts.push(off + t.cuts[i]) }
        off += seg.length + 1
      }
      return { ids, seg: ids.map(sylStr), partial: '', alts: [ids], cuts }
    }
    const best = dpTopK(py, K)
    let end = -1
    for (let i = py.length; i >= 0; i--) if (best[i] && best[i].length) { end = i; break }
    if (end <= 0) return { ids: [], seg: [], partial: py, alts: [], cuts: [] }
    const alts = traceTopK(best, end, K)
    if (!alts.length) return { ids: [], seg: [], partial: py, alts: [], cuts: [] }
    return {
      ids: alts[0].ids,
      seg: alts[0].ids.map(sylStr),
      partial: end < py.length ? py.substr(end) : '',
      alts: alts.map(a => a.ids),
      cuts: alts[0].cuts
    }
  }

  function prefixChars(prefix, limit) {
    const buf = []
    for (const id of startingWith(prefix)) {
      const n = Math.min(COFF[id + 1] - COFF[id], 12)
      for (let r = 0; r < n; r++) buf.push({ c: charAt(id, r), rank: r, s: sylScore[id] })
    }
    buf.sort((a, b) => (a.rank - b.rank) || (b.s - a.s))
    let out = ''
    for (let i = 0; i < buf.length && out.length < limit; i++) if (out.indexOf(buf[i].c) === -1) out += buf[i].c
    return out
  }

  function pushAll(dst, src) { for (let i = 0; i < src.length; i++) dst.push(src[i]) }

  function query(py, limit = 40) {
    const raw = (py || '').toLowerCase().replace(/[^a-z']/g, '')
    const seg = segment(raw)
    const tail = seg.partial || ''
    const alts = seg.alts || []
    const cap = Math.max(limit * 3, 24)

    // 两轮：先「已敲音节完全匹配」（所有候选切分都试，用于消歧），
    // 再「末音节按前缀补完」（只用主切分 —— 备选切分是拿来消歧的，
    // 不是拿来造新解析的，否则 'ren' 会因为 re|n 这条备选而冒出「热闹」）
    const exact = [], pref = []
    if (alts.length) {
      for (const alt of alts) {
        if (alt.length >= 1) pushAll(exact, scanGroup(alt[0], alt, alt.length, '', cap))
      }
      const main = alts[0]
      if (tail) pushAll(pref, scanGroup(main[0], main, main.length + 1, tail, cap))
      else if (main.length >= 1) pushAll(pref, scanGroup(main[0], main, main.length, sylStr(main[main.length - 1]), cap))
    } else if (tail) {
      for (const id of startingWith(tail)) pushAll(pref, scanGroup(id, [id], 1, '', cap))
    }
    exact.sort((a, b) => a.score - b.score)
    pref.sort((a, b) => a.score - b.score)
    const hit = exact.concat(pref)

    const words = []
    for (let i = 0; i < hit.length && words.length < limit; i++) {
      if (words.indexOf(hit[i].w) === -1) words.push(hit[i].w)
    }

    let L = 0
    if (alts.length) L = alts[0].length + (tail ? 1 : 0)
    else if (tail) L = 1

    let chars = ''
    if (L <= 1 || (!words.length && L > 1)) {
      if (alts.length) { const id0 = alts[0][0]; chars = CHARS.slice(COFF[id0], COFF[id0 + 1]) }
      else if (tail) chars = prefixChars(tail, limit)
    }

    const candidates = words.slice(0, limit)
    for (let i = 0; i < chars.length && candidates.length < limit; i++) {
      if (candidates.indexOf(chars[i]) === -1) candidates.push(chars[i])
    }

    const syllables = alts.length ? alts[0].map(sylStr) : []
    return {
      input: raw, syllables, tail, length: L,
      words, chars, candidates,
      display: syllables.join(' ') + (tail ? ' ' + tail : '')
    }
  }

  // 逐字提交：选了 n 个字后还剩多少拼音。remaining('nihao', 1) -> 'hao'
  function remaining(py, n) {
    const raw = (py || '').toLowerCase().replace(/[^a-z']/g, '')
    const seg = segment(raw)
    if (!seg.cuts || seg.cuts.length < n) return ''
    return raw.slice(seg.cuts[n - 1])
  }

  function charsOfSyllable(syl) {
    const id = typeof syl === 'number' ? syl : sylId(syl)
    if (id < 0) {
      const seg = segment(syl)
      const id0 = seg.ids[0]
      return seg.ids.length ? CHARS.slice(COFF[id0], COFF[id0 + 1]) : ''
    }
    return CHARS.slice(COFF[id], COFF[id + 1])
  }

  const letterOf = gid => SYLS.charAt(SOFF[gid])
  const rangeOf = L => {
    const k = (typeof L === 'string' ? L.charCodeAt(0) : L) - 97
    if (k < 0 || k >= 26 || !SEEN[k]) return null
    return [LO[k], HI[k]]
  }
  return {
    query, segment, remaining, charsOfSyllable, attachPhrase,
    attachPhraseLoader, ensureGroup, letterOf, rangeOf,
    _shards: () => shards.size
  }
}
