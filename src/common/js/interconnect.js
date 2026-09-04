/******************************************************************************
 * @file        interconnect.js
 * @description 设备通信模块 - 处理与手机App的数据交互
 * @author      B4QAQ
 * @source      ResonaUI
 * @version     1.0
 * @copyright   2026 B4QAQ@MCNS.
 * @license     AGPL-3.0-only
 ******************************************************************************/

import interconnect from '@system.interconnect'
import file from '@system.file'
import crypto from '@system.crypto'
import { getDeviceInfo, getSettings } from './useful.js'
import * as simpleFetch from './simpleFetch.js'

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
let base64Table = null

/**
 * 查表解码 base64，直接产出 Uint8Array（不经过二进制字符串，避免高字节被编码污染）
 */
function decodeBase64(base64) {
  if (!base64Table) {
    const table = new Int16Array(256)
    table.fill(-1)
    for (let i = 0; i < BASE64_CHARS.length; i++) table[BASE64_CHARS.charCodeAt(i)] = i
    base64Table = table
  }
  const input = String(base64).replace(/[^A-Za-z0-9+/=]/g, '')
  const len = input.length
  if (len === 0) return new Uint8Array(0)
  const padding = input[len - 1] === '=' ? (input[len - 2] === '=' ? 2 : 1) : 0
  const output = new Uint8Array((len >> 2) * 3 - padding)
  let out = 0
  for (let i = 0; i < len; i += 4) {
    const c1 = base64Table[input.charCodeAt(i)]
    const c2 = base64Table[input.charCodeAt(i + 1)]
    const c3 = input.charCodeAt(i + 2) === 61 ? 0 : base64Table[input.charCodeAt(i + 2)]
    const c4 = input.charCodeAt(i + 3) === 61 ? 0 : base64Table[input.charCodeAt(i + 3)]
    const v = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4
    output[out++] = (v >> 16) & 0xff
    if (out < output.length) output[out++] = (v >> 8) & 0xff
    if (out < output.length) output[out++] = v & 0xff
  }
  return output
}

/**
 * 确保 uri 的父目录存在（已存在时忽略错误）
 */
function ensureDir(uri) {
  const slash = uri.lastIndexOf('/')
  if (slash < 0) return Promise.resolve()
  const dir = uri.substring(0, slash)
  return new Promise((resolve) => {
    file.mkdir({ uri: dir, success: resolve, fail: () => resolve() })
  })
}

/**
 * 将通过互联传入的数据解码为 Uint8Array
 * 互联走 JSON，二进制以 base64 字符串传输；兼容 data URI 和已是 Uint8Array 的情况
 * 注意：file.writeArrayBuffer 的 buffer 参数要求 Uint8Array（非 ArrayBuffer）
 */
function decodeBuffer(data) {
  if (typeof data !== 'string') return data
  let str = data
  const comma = str.indexOf(',')
  if (str.startsWith('data:') && comma >= 0) str = str.substring(comma + 1)
  const binary = crypto.atob(str)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * 初始化设备通信
 */
export function initInterconnect() {
  try {
    global.interconnectInstance = interconnect.instance()

    // 注册连接打开回调
    global.interconnectInstance.onopen = (data) => {
      console.log('[设备通信] 连接已打开, isReconnected:', data.isReconnected)
      global.InterconnectStatus = 1
    }

    // 注册连接关闭回调
    global.interconnectInstance.onclose = (data) => {
      console.log('[设备通信] 连接已关闭, reason:', data.data, 'code:', data.code)
      global.InterconnectStatus = 2
      if (simpleFetch.isBridgeActive()) {
        simpleFetch.deactivateBridge()
      }
    }

    // 注册连接错误回调
    global.interconnectInstance.onerror = (data) => {
      console.log('[设备通信] 连接错误, errMsg:', data.data, 'errCode:', data.code)
      global.InterconnectStatus = 2
    }

    // 注册消息接收回调
    global.interconnectInstance.onmessage = (data) => {
      console.log('[设备通信] 收到消息:', data.data)
      try {
        const msg = typeof data.data === 'string' ? JSON.parse(data.data) : data.data
        handleInterconnectMessage(msg)
      } catch (e) {
        console.log('[设备通信] 消息解析失败:', e)
        // 非JSON消息，可能是握手协议等
        if (data.data === 'start') {
          global.interconnectInstance.send({ data: { type: 'ready', timestamp: Date.now() } })
        }
      }
    }

    // 获取当前连接状态
    checkInterconnectStatus()
    console.log('[设备通信] 初始化完成')
  } catch (e) {
    console.log('[设备通信] 初始化失败:', e)
    global.uiAdm.MessageBox('[E]设备通信初始化失败')
    global.InterconnectStatus = 0
  }
}

/**
 * 检查设备通信连接状态
 * @return {Promise<number>} 状态码: 1-已连接, 2-已断开
 */
export function checkInterconnectStatus() {
  return new Promise((resolve) => {
    if (!global.interconnectInstance) {
      resolve(0)
      return
    }

    global.interconnectInstance.getReadyState({
      success: (data) => {
        global.InterconnectStatus = data.status
        console.log('[设备通信] 当前状态:', data.status === 1 ? '已连接' : '已断开')
        resolve(data.status)
      },
      fail: (data, code) => {
        console.log('[设备通信] 获取状态失败, code:', code, 'msg:', data)
        global.uiAdm.MessageBox(`[E${code}]获取通信状态失败`)
        global.InterconnectStatus = 2
        resolve(2)
      }
    })
  })
}

/**
 * 诊断设备通信连接
 * @param {number} timeout 超时时间(毫秒), 默认10000
 * @return {Promise<Object>} 诊断结果 {status: number, message: string}
 */
export function diagnosisInterconnect(timeout = 10000) {
  return new Promise((resolve) => {
    if (!global.interconnectInstance) {
      resolve({ status: -1, message: '通信实例未初始化' })
      return
    }

    global.interconnectInstance.diagnosis({
      timeout: timeout,
      success: (data) => {
        const statusMap = {
          0: '连接成功',
          204: '连接超时',
          1001: '对端应用未安装',
          1000: '其他连接错误'
        }
        console.log('[设备通信] 诊断结果:', statusMap[data.status] || '未知状态')
        resolve({ status: data.status, message: statusMap[data.status] || '未知状态' })
      },
      fail: (data, code) => {
        console.log('[设备通信] 诊断失败, code:', code, 'msg:', data)
        global.uiAdm.MessageBox(`[E${code}]诊断失败:` + (data || '未知错误'))
        resolve({ status: code, message: data || '诊断失败' })
      }
    })
  })
}

/**
 * 发送数据到手机App
 * @param {Object} data 要发送的数据对象
 * @return {Promise<boolean>} 发送结果
 */
export function sendInterconnectData(data) {
  return new Promise((resolve) => {
    if (!global.interconnectInstance) {
      console.log('[设备通信] 发送失败: 通信实例未初始化')
      global.uiAdm.MessageBox('发送数据失败:未初始化')
      resolve(false)
      return
    }

    global.interconnectInstance.send({
      data: data,
      success: () => {
        console.log('[设备通信] 发送成功:', JSON.stringify(data))
        resolve(true)
      },
      fail: (data, code) => {
        console.log('[设备通信] 发送失败, code:', code, 'msg:', data)
        global.uiAdm.MessageBox(`[E${code}]发送数据失败:` + data)
        resolve(false)
      }
    })
  })
}

/**
 * 处理接收到的设备通信消息
 * @param {Object} msg 接收到的数据 {type, status, data}
 */
export async function handleInterconnectMessage(msg) {
  const { type, status, data } = msg

  // 如果有status且不为OK，检查是否为SimpleFetch消息
  if (status && status !== 'OK') {
    if (type && type.startsWith('SF_')) {
      simpleFetch.handleMessage(msg)
      return
    }
    console.log('[设备通信] 收到错误状态:', status)
    global.uiAdm.MessageBox('[E]' + status)
    return
  }

  try {
    switch (type) {
      // GET 请求
      case 'GET_APIKEY': {
        sendInterconnectData({ type: 'APIKEY', status: 'OK', data: global.APIKey || '' })
        break
      }
      case 'GET_SETTINGS': {
        const settings = await global.storageManager.getSettings()
        sendInterconnectData({ type: 'SETTINGS', status: 'OK', data: settings || {} })
        break
      }
      case 'GET_DEVICEINFO': {
        const device = await getDeviceInfo()
        sendInterconnectData({ type: 'DEVICEINFO', status: 'OK', data: device || {} })
        break
      }
      case 'GET_FETCHAVA': {
        sendInterconnectData({ type: 'FETCHAVA', status: 'OK', data: global.fetchAva || {} })
        break
      }

      // PUT 请求
      case 'PUT_SETTINGS': {
        await global.storageManager.saveSettings(data)
        await getSettings()
        sendInterconnectData({ type: 'PUT_SETTINGS_DONE', status: 'OK', data: data })
        break
      }
      case 'UPLOAD_FILE': {
        try {
          if (!data?.uri) throw new Error('缺少 uri')
          if (!data?.data) throw new Error('缺少 data')
          const bytes = decodeBase64(data.data)
          await ensureDir(data.uri)
          await new Promise((resolve, reject) => {
            file.writeArrayBuffer({
              uri: data.uri,
              buffer: bytes,
              append: data.append,
              position: data.position,
              success: resolve,
              fail: (d, code) => reject(`写入失败: ${code}`)
            })
          })
          sendInterconnectData({ type: 'UPLOAD_FILE_DONE', status: 'OK', data: { uri: data.uri } })
        } catch (e) {
          sendInterconnectData({ type: 'UPLOAD_FILE_DONE', status: e.toString(), data: { uri: data?.uri } })
        }
        break
      }
      case 'DEL_FILE': {
        try {
          await new Promise((resolve, reject) => {
            file.delete({ uri: data?.uri, success: resolve, fail: (_, code) => reject(`删除失败: ${code}`) })
          })
          sendInterconnectData({ type: 'DEL_FILE_DONE', status: 'OK', data: { uri: data?.uri } })
        } catch (e) {
          sendInterconnectData({ type: 'DEL_FILE_DONE', status: e.toString(), data: { uri: data?.uri } })
        }
        break
      }

      default:
        // SimpleFetch消息
        if (type && type.startsWith('SF_')) {
          simpleFetch.handleMessage(msg)
          break
        }
        console.log('[设备通信] 未知的消息类型:', type)
        global.uiAdm.MessageBox('[W]收到未知消息类型:' + (type || '未知'))
    }
  } catch (e) {
    console.log('[设备通信] 处理消息异常:', e)
    global.uiAdm.MessageBox('[E]处理消息异常')
  }
}
