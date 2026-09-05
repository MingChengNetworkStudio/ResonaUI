/******************************************************************************
 * @file        simpleFetch.js
 * @description SimpleFetch模块 - 通过互联通道代理网络请求
 * @author      B4QAQ
 * @source      ResonaUI
 * @version     1.2
 * @copyright   2026 B4QAQ@MCNS.
 * @license     AGPL-3.0-only
 ******************************************************************************/

import { sendInterconnectData, uploadFile } from './interconnect.js'
import { getDeviceInfo } from './useful.js'
import crypto from '@system.crypto'

// ===== 常量 =====
const HEARTBEAT_INTERVAL = 10000
const HEARTBEAT_TIMEOUT = 5000

// ===== 私有状态 =====
let _reqCounter = 0
let _bridgeActive = false
let _heartbeatTimer = null
let _heartbeatTimeout = null
let _handshakeTimer = null
let _handshakeResolve = null
let _handshakeInFlight = null
const _pending = new Map()
const _sseHandlers = new Map()
const _downloadPending = new Map()

// ===== 工具函数 =====

function _nextId() {
  return 'sf_' + (++_reqCounter)
}

/**
 * 解析响应体，对齐 @system.fetch 行为：
 * - responseType 为 text/arraybuffer 时不解析
 * - responseType 为 json 时强制 JSON.parse
 * - 未指定 responseType 时，根据 Content-Type 自动解析 json
 * @param {string} body 响应体字符串
 * @param {string} responseType 调用方指定的返回类型
 * @param {Object} headers 响应头
 * @return {string|Object} 解析后的响应
 */
function _parseBody(body, responseType, headers) {
  if (typeof body !== 'string') return body
  if (responseType === 'text' || responseType === 'arraybuffer' || responseType === 'file') {
    return body
  }
  if (responseType === 'json') {
    try { return JSON.parse(body) } catch (e) { return body }
  }
  // 未指定类型：根据 Content-Type 自动判断
  const contentType = (headers && (headers['content-type'] || headers['Content-Type'])) || ''
  if (/application\/json|text\/json/i.test(contentType)) {
    try { return JSON.parse(body) } catch (e) { return body }
  }
  return body
}

/**
 * 构造请求头：对齐原生 @system.fetch 行为，当带请求体却没有声明 Content-Type 时
 * 按内容补全默认值（对象/JSON 字符串用 application/json），避免服务端无法解析 body。
 * @param {Object} header 调用方传入的请求头
 * @param {string|null} body 已序列化的请求体字符串
 * @return {Object} 新的请求头对象（不修改入参）
 */
function _buildHeaders(header, body) {
  const h = Object.assign({}, header || {})
  if (body !== null && body !== undefined) {
    const hasCT = Object.keys(h).some(k => k.toLowerCase() === 'content-type')
    if (!hasCT) {
      const first = String(body).replace(/^\s+/, '').charAt(0)
      h['Content-Type'] = (first === '{' || first === '[')
        ? 'application/json;charset=UTF-8'
        : 'application/x-www-form-urlencoded'
    }
  }
  return h
}

// 激活桥接：设置状态并启动心跳
function _activateBridge() {
  global.NetworkStatus = 'bridge'
  global.fetchAva = true
  _bridgeActive = true
  _startHeartbeat()
  global.uiAdm.MessageBox('桥接网络已连接')
  console.log('[SimpleFetch] 桥接握手成功')
  // 若由快应用主动发起握手，resolve等待中的Promise
  if (_handshakeResolve) {
    _handshakeResolve(true)
    _handshakeResolve = null
  }
  if (_handshakeTimer) { clearTimeout(_handshakeTimer); _handshakeTimer = null }
}

// ===== 心跳 =====

function _startHeartbeat() {
  _stopHeartbeat()
  _heartbeatTimer = setInterval(() => {
    const ts = Date.now()
    sendInterconnectData({ type: 'SF_PING', data: { ts } })
    _heartbeatTimeout = setTimeout(() => {
      console.log('[SimpleFetch] 心跳超时，停用桥接')
      global.uiAdm.MessageBox('桥接网络心跳超时')
      deactivateBridge()
    }, HEARTBEAT_TIMEOUT)
  }, HEARTBEAT_INTERVAL)
}

function _stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null }
  if (_heartbeatTimeout) { clearTimeout(_heartbeatTimeout); _heartbeatTimeout = null }
}

// ===== 导出函数 =====

/**
 * 发起网络请求（通过互联通道代理）
 * 接口兼容 @system.fetch 的 fetch.fetch()，接受相同的 requestConfig，返回相同的响应格式
 * @param {Object} config 请求配置（与 @system.fetch.fetch 参数一致）
 * @param {string} config.url 请求地址
 * @param {string} [config.method='GET'] HTTP方法
 * @param {Object} [config.header={}] 请求头
 * @param {string|Object|null} [config.data=null] 请求参数
 * @param {string} [config.responseType] 返回类型 text/json/file/arraybuffer
 * @param {number} [config.timeout=15000] 超时时间(ms)
 * @return {Promise<Object>} 响应 { data: { code, data, headers } }（与 @system.fetch Promise 一致）
 */
export function fetch(config) {
  const { url, header = {}, data = null, responseType, timeout = 15000 } = config
  const method = (config.method || 'GET').toUpperCase()
  const id = _nextId()

  // 将data转为body字符串
  let body = null
  if (data !== null) {
    body = typeof data === 'string' ? data : JSON.stringify(data)
  }
  // 对齐原生 fetch：带 body 时补全 Content-Type
  const headers = _buildHeaders(header, body)

  return new Promise((resolve, reject) => {
    if (!_bridgeActive) {
      reject({ code: 0, data: '桥接未连接' })
      return
    }

    const timer = setTimeout(() => {
      _pending.delete(id)
      reject({ code: 0, data: '请求超时' })
    }, timeout)

    _pending.set(id, { resolve, reject, timer, responseType })
    sendInterconnectData({
      type: 'SF_REQUEST',
      data: { id, url, method, headers, body, sse: false, timeout }
    })
  })
}

/**
 * 发起SSE请求（通过互联通道代理）
 * @param {Object} options 请求选项
 * @param {string} options.url SSE端点地址
 * @param {Object} [options.headers={}] 请求头
 * @param {number} [options.timeout=30000] 超时时间(ms)
 * @return {Object} { onEvent, onError, onClose, close }
 */
export function sse(options) {
  const { url, headers = {}, timeout = 30000 } = options
  const id = _nextId()
  const handlers = { onEvent: null, onError: null, onClose: null }

  if (!_bridgeActive) {
    if (handlers.onError) handlers.onError('桥接未连接')
    return { onEvent: () => {}, onError: () => {}, onClose: () => {}, close: () => {} }
  }

  const timer = setTimeout(() => {
    _sseHandlers.delete(id)
    if (handlers.onError) handlers.onError('SSE连接超时')
  }, timeout)

  _sseHandlers.set(id, { handlers, timer })

  sendInterconnectData({
    type: 'SF_REQUEST',
    data: { id, url, method: 'GET', headers, body: null, sse: true, timeout }
  })

  return {
    onEvent: (cb) => { handlers.onEvent = cb },
    onError: (cb) => { handlers.onError = cb },
    onClose: (cb) => { handlers.onClose = cb },
    close: () => {
      clearTimeout(timer)
      _sseHandlers.delete(id)
      sendInterconnectData({ type: 'SF_CLOSE', data: { id } })
    }
  }
}

/**
 * 通过SF通道下载文件
 * @param {Object} config 下载配置
 * @param {string} config.url 下载地址
 * @param {string} [config.filename] 下载文件名
 * @param {Object} [config.header={}] 请求头
 * @param {string} [config.uri] SF扩展：目标路径，分片直接写入此路径
 * @param {Function} [config.success] 成功返回 { token } 的回调
 * @param {Function} [config.fail] 启动失败的回调
 * @param {Function} [config.complete] 结束回调
 */
export function download(config) {
  const { url, filename, header = {}, uri, success, fail, complete } = config
  const id = _nextId()

  if (!_bridgeActive) {
    if (fail) fail('桥接未连接', 0)
    if (complete) complete()
    return
  }

  _downloadPending.set(id, { id, uri, success, fail, complete })

  // 立即返回 token（id 即为 token，与原生 request.download 行为一致）
  if (success) success({ token: id })

  // 通知手机端开始下载
  sendInterconnectData({
    type: 'SF_DOWNLOAD',
    data: { id, url, headers: header, filename }
  })
}

/**
 * 模拟 @system.request.onDownloadComplete：注册下载完成回调
 * @param {Object} config
 * @param {string} config.token 任务 token（即 download 返回的 id）
 * @param {Function} [config.success] 成功返回 { uri } 的回调
 * @param {Function} [config.fail] 失败的回调
 * @param {Function} [config.complete] 结束回调
 */
export function onDownloadComplete(config) {
  const { token, success, fail, complete } = config
  const task = _downloadPending.get(token)
  if (task) {
    task.onDownloadComplete = { success, fail, complete }
  }
}

/**
 * 处理SF_开头的互联消息（由interconnect.js调用）
 * @param {Object} msg 消息对象 { type, status, data }
 */
export async function handleMessage(msg) {
  const { type, status, data } = msg

  if (type === 'SF_HANDSHAKE') {
    // 手机发起握手：回复ACK，激活桥接
    sendInterconnectData({ type: 'SF_HANDSHAKE_ACK', status: 'OK', data: {} })
    _activateBridge()
    return
  }

  if (type === 'SF_HANDSHAKE_ACK') {
    // 快应用发起握手后收到手机回复
    if (_handshakeTimer) { clearTimeout(_handshakeTimer); _handshakeTimer = null }
    _activateBridge()
    return
  }

  if (type === 'SF_CLOSE_BRIDGE') {
    // 手机要求关闭桥接：回复确认，停用桥接
    sendInterconnectData({ type: 'SF_CLOSE_BRIDGE_ACK', status: 'OK', data: {} })
    deactivateBridge()
    return
  }

  if (type === 'SF_PONG') {
    // 心跳回复：清除超时
    if (_heartbeatTimeout) { clearTimeout(_heartbeatTimeout); _heartbeatTimeout = null }
    return
  }

  if (type === 'SF_RESPONSE') {
    const { id, statusCode, headers, body, chunk, totalChunks } = data

    // 错误响应
    if (status !== 'OK') {
      const pending = _pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        _pending.delete(id)
        pending.reject({ code: statusCode || 0, data: status })
      }
      return
    }

    // 无分片（totalChunks === 0）
    if (!totalChunks) {
      const pending = _pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        _pending.delete(id)
        // 兼容 @system.fetch Promise 返回格式 { data: { code, data, headers } }
        const responseData = _parseBody(body, pending.responseType, headers)
        pending.resolve({ data: { code: statusCode, data: responseData, headers } })
      }
      return
    }

    // 有分片
    let pending = _pending.get(id)
    if (!pending) return

    if (chunk === 1) {
      pending.chunks = new Map()
      pending.chunkTotal = totalChunks
      pending.statusCode = statusCode
      pending.headers = headers
    }

    if (pending.chunks) {
      pending.chunks.set(chunk, body)
    }

    // 收齐所有分片
    if (pending.chunks && pending.chunks.size === pending.chunkTotal) {
      clearTimeout(pending.timer)
      _pending.delete(id)
      let assembled = ''
      for (let i = 1; i <= pending.chunkTotal; i++) {
        assembled += pending.chunks.get(i) || ''
      }
      const decoded = crypto.atob(assembled)
      const responseData = _parseBody(decoded, pending.responseType, pending.headers)
      pending.resolve({ data: { code: pending.statusCode, data: responseData, headers: pending.headers } })
    }
    return
  }

  if (type === 'SF_SSE_EVENT') {
    const sse = _sseHandlers.get(data.id)
    if (sse) {
      // 收到首个事件，清除连接超时
      if (sse.timer) { clearTimeout(sse.timer); sse.timer = null }
      if (sse.handlers.onEvent) sse.handlers.onEvent(data.event, data.data)
    }
    return
  }

  if (type === 'SF_SSE_END') {
    const sse = _sseHandlers.get(data.id)
    if (sse) {
      if (sse.timer) clearTimeout(sse.timer)
      _sseHandlers.delete(data.id)
      if (sse.handlers.onClose) sse.handlers.onClose()
    }
    return
  }

  if (type === 'SF_SSE_ERROR') {
    const sse = _sseHandlers.get(data.id)
    if (sse) {
      if (sse.timer) clearTimeout(sse.timer)
      _sseHandlers.delete(data.id)
      if (sse.handlers.onError) sse.handlers.onError(status || data.error || 'SSE错误')
    }
    return
  }

  if (type === 'SF_DL_RESPONSE') {
    const { id, append, isLast, data: body } = data
    if (!id) return
    const task = _downloadPending.get(id)
    if (!task) {
      console.log('[SimpleFetch] 收到未知下载分片, id:', id)
      return
    }
    if (!body) {
      _failDownloadTask(task, 0, '手机端未返回文件内容')
      return
    }
    await uploadFile({ uri: task.uri ,data: body, append:append})
    if (isLast) _completeDownloadTask(task, task.uri)
    return
  }

  if (type === 'SF_DL_FAIL') {
    const { id } = data
    if (!id) return
    const task = _downloadPending.get(id)
    if (!task) return
    _failDownloadTask(task, 0, status || data.message || '下载失败')
    return
  }
}

/**
 * 下载成功完成：触发 onDownloadComplete 的 success 回调
 * @param {Object} task 任务状态
 * @param {string} uri 目标路径
 */
function _completeDownloadTask(task, uri) {
  _downloadPending.delete(task.id)
  if (task.onDownloadComplete) {
    if (task.onDownloadComplete.success) task.onDownloadComplete.success({ uri })
    if (task.onDownloadComplete.complete) task.onDownloadComplete.complete()
  }
}

/**
 * 下载失败：触发 onDownloadComplete 的 fail 回调
 * @param {Object} task 任务状态
 * @param {number} code 错误码
 * @param {string} message 错误信息
 */
function _failDownloadTask(task, code, message) {
  _downloadPending.delete(task.id)
  if (task.onDownloadComplete) {
    if (task.onDownloadComplete.fail) task.onDownloadComplete.fail(message, code)
    if (task.onDownloadComplete.complete) task.onDownloadComplete.complete()
  } else {
    if (task.fail) task.fail(message, code)
    if (task.complete) task.complete()
  }
}

/**
 * 快应用主动发起握手（由设置项等手动触发）
 * @param {number} [timeout=5000] 握手超时时间(ms)
 * @return {Promise<boolean>} 握手是否成功
 */
export function startHandshake(timeout = 5000) {
  // 已有握手在进行中：复用同一个Promise，避免重复点击/重复调用发出多次握手
  if (_handshakeInFlight) return _handshakeInFlight

  _handshakeInFlight = new Promise((resolve) => {
    // 无论成功失败，只结算一次并清掉锁
    const settle = (result) => {
      _handshakeInFlight = null
      resolve(result)
    }

    if (_bridgeActive) {
      global.uiAdm.MessageBox('桥接网络已连接')
      settle(true)
      return
    }

    // 实时查询互联连接状态，不依赖可能滞后的 global.InterconnectStatus
    const instance = global.interconnectInstance
    if (!instance) {
      global.uiAdm.MessageBox('设备通信未初始化')
      settle(false)
      return
    }

    instance.getReadyState({
      success: (data) => {
        if (data.status !== 1) {
          global.uiAdm.MessageBox('设备通信未连接')
          settle(false)
          return
        }
        global.InterconnectStatus = 1
        _doHandshake(timeout, settle)
      },
      fail: () => {
        global.uiAdm.MessageBox('设备通信未连接')
        settle(false)
      }
    })
  })

  return _handshakeInFlight
}

// 实际发送握手报文（连接已确认可用）
function _doHandshake(timeout, resolve) {
  // 清除旧的握手等待
  if (_handshakeTimer) clearTimeout(_handshakeTimer)
  _handshakeResolve = resolve

  sendInterconnectData({ type: 'SF_HANDSHAKE', data: {} })

  _handshakeTimer = setTimeout(() => {
    _handshakeTimer = null
    _handshakeResolve = null
    global.uiAdm.MessageBox('握手超时,请检查手机端')
    resolve(false)
  }, timeout)
}

/**
 * 查询桥接是否激活
 * @return {boolean}
 */
export function isBridgeActive() {
  return _bridgeActive
}

/**
 * 停用桥接（由interconnect.js的onclose调用）
 */
export function deactivateBridge() {
  _stopHeartbeat()
  _bridgeActive = false
  global.NetworkStatus = 'none'
  global.fetchAva = false
  // reject所有待处理请求
  _pending.forEach((p) => {
    clearTimeout(p.timer)
    p.reject({ code: 0, data: '桥接连接断开' })
  })
  _pending.clear()
  // 通知所有SSE
  _sseHandlers.forEach((sse) => {
    if (sse.timer) clearTimeout(sse.timer)
    if (sse.handlers.onError) sse.handlers.onError('桥接连接断开')
  })
  _sseHandlers.clear()
  // 通知所有挂起的下载（已注册 onDownloadComplete 的走 onDownloadComplete.fail，否则走 download.fail）
  _downloadPending.forEach((task) => {
    const msg = '桥接连接断开'
    if (task.onDownloadComplete) {
      if (task.onDownloadComplete.fail) task.onDownloadComplete.fail(msg, 0)
      if (task.onDownloadComplete.complete) task.onDownloadComplete.complete()
    } else {
      if (task.fail) task.fail(msg, 0)
      if (task.complete) task.complete()
    }
  })
  _downloadPending.clear()
  // 刷新设备信息
  getDeviceInfo()
  global.uiAdm.MessageBox('桥接网络已断开')
  console.log('[SimpleFetch] 桥接已停用')
}
