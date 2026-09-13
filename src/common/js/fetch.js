/******************************************************************************
 * @file        fetch.js
 * @description 网络请求模块（仅MingChenAPI）
 * @author      B4QAQ
 * @source      ResonaUI
 * @version     5.0
 * @copyright   2026 B4QAQ@MCNS.
 * @license     MIT
 ******************************************************************************/

import fetch from '@system.fetch'
import * as simpleFetch from './simpleFetch.js'


/**
 * 发送网络请求
 * @param {string} url       请求地址
 * @param {boolean} isapi     是否为API请求(默认true)
 * @param {Object} parameter  请求参数(默认{})
 * @return {Object} 请求结果
 */
export async function sendFetch(url, isapi = true, parameter = {}) {
  // 检查网络状态
  if (global.NetworkStatus === 'none') {
    console.log('[X] 无网络连接')
    return { status: 503, result: '无网络连接' }
  }

  console.log(`[+] 请求: ${url}, 类型: ${isapi ? 'API(POST)' : '外部(GET)'}`, parameter)

  const requestConfig = { timeout: 10000 }

  if (isapi) {
    requestConfig.url = `https://api.b4qaq.cn/api/v2${url}/ResonaUI`
    requestConfig.method = 'POST'
    requestConfig.data = { ...parameter, Key: global.APIKey }
  } else {
    requestConfig.url = encodeURI(url)
    requestConfig.method = 'GET'
  }

  console.log('[>] 请求配置:', requestConfig)

  // 桥接模式走SimpleFetch，否则走原生fetch
  const fetcher = global.NetworkStatus === 'bridge' ? simpleFetch : fetch

  try {
    const response = await fetcher.fetch(requestConfig)
    if (response.data.code !== 200) {
      console.log(`[-] 请求失败: ${url}`, response)
      return {
        status: response.data.code,
        result: response.data.code === 300 ? '网络异常,请检查网络后再试' : response.data.data.result
      }
    }
    console.log('[+] 请求成功')
    return response.data.data
  } catch (e) {
    console.log('[X] 请求异常:', e)
    return { status: e.code, result: '请求异常:' + e.data }
  }
}