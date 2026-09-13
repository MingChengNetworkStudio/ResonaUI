/******************************************************************************
 * @file        download.js
 * @description 多线程文件下载
 * @author      B4QAQ
 * @source      ResonaUI
 * @version     1.0
 * @copyright   2026 B4QAQ@MCNS.
 * @license     MPL-2.0-only
 ******************************************************************************/

import request from '@system.request'
import file from '@system.file'
import * as simpleFetch from './simpleFetch.js'

const MAX_THREAD = 3

if (!global.downloadStatus) global.downloadStatus = { total: 0, completed: 0, failed: 0, running: 0 }
if (!global.downloadQueue) global.downloadQueue = []
if (!global.downloadListeners) global.downloadListeners = { complete: [], fail: [] }

/**
 * 通知所有订阅者
 * @param {string} event 事件名('complete'|'fail')
 * @param {Object} data 事件数据
 */
function notify(event, data) {
    const listeners = global.downloadListeners[event] || []
    listeners.forEach(fn => fn(data))
}

/**
 * 移动文件到目标路径
 * @param {string} sourceUri 源文件URI
 * @param {string} targetPath 目标路径
 * @return {Promise<string>} 目标路径
 */
function moveFile(sourceUri, targetPath) {
    return new Promise((resolve, reject) => {
        file.mkdir({
            uri: targetPath.replace(/\/[^/]+$/, ''),
            recursive: true,
            success: () => {
                file.move({
                    srcUri: sourceUri,
                    dstUri: targetPath,
                    success: () => resolve(targetPath),
                    fail: (err, code) => reject({ code, message: `文件移动失败: ${code}` })
                })
            },
            fail: (err, code) => reject({ code, message: `目录创建失败: ${code}` })
        })
    })
}

/**
 * 处理下载队列，维持并发数
 */
function processQueue() {
    while (global.downloadStatus.running < MAX_THREAD && global.downloadQueue.length > 0) {
        global.downloadStatus.running++
        startDownload(global.downloadQueue.shift())
    }
}

/**
 * 开始单个下载任务
 * @param {Object} task 任务对象{url,filename,targetPath,header}
 */
function startDownload(task) {
    const config = {
        url: task.url,
        filename: task.filename
    }
    if (task.header && Object.keys(task.header).length > 0) {
        config.header = task.header
    }
    // 桥接模式走SimpleFetch，否则走原生request（与 fetch.js 中 sendFetch 风格一致）
    const downloader = (global.NetworkStatus === 'bridge' && simpleFetch.isBridgeActive()) ? simpleFetch : request
    // SF 模式下将 targetPath 透传给 downloader，让分片直接写入 targetPath
    if (downloader === simpleFetch && task.targetPath) {
        config.uri = task.targetPath
    }
    downloader.download({
        ...config,
        success: (res) => {
            downloader.onDownloadComplete({
                token: res.token,
                success: async (data) => {
                    global.downloadStatus.running--
                    global.downloadStatus.completed++
                    let result = { code: 0, uri: data.uri, total: global.downloadStatus.total, completed: global.downloadStatus.completed }
                    if (task.targetPath) {
                        // 当使用SimpleFetch下载时,文件直接保存到targetPath,所以无需移动文件,直接上报文件地址为data.uri
                        if(data.uri == task.targetPath) {
                            result.uri = data.uri
                            return
                        }
                        try {
                            result.uri = await moveFile(data.uri, task.targetPath)
                        } catch (e) {
                            console.log(`[Download] ${e.message}`)
                        }
                    }
                    notify('complete', result)
                    processQueue()
                },
                fail: (err, code) => {
                    global.downloadStatus.running--
                    global.downloadStatus.failed++
                    notify('fail', { code, message: `下载失败: ${code}`, total: global.downloadStatus.total, failed: global.downloadStatus.failed })
                    processQueue()
                }
            })
        },
        fail: (err, code) => {
            global.downloadStatus.running--
            global.downloadStatus.failed++
            notify('fail', { code, message: `无法开始下载: ${code}`, total: global.downloadStatus.total, failed: global.downloadStatus.failed })
            processQueue()
        }
    })
}

/**
 * 添加下载任务
 * @param {string} url 下载地址
 * @param {string} targetPath 目标路径(最终保存位置)
 * @param {Object} options 配置项{header}
 */
export function addDownload(url, targetPath, options = {}) {
    global.downloadQueue.push({
        url,
        filename: targetPath.replace('internal://files/', '').split('/').pop(),
        targetPath,
        header: options.header || {}
    })
    global.downloadStatus.total++
    processQueue()
}

/**
 * 订阅下载事件
 * @param {string} event 事件名('complete'|'fail')
 * @param {Function} callback 回调函数
 * @return {Function} 取消订阅函数
 */
export function onDownloadEvent(event, callback) {
    global.downloadListeners[event].push(callback)
    return () => {
        const idx = global.downloadListeners[event].indexOf(callback)
        if (idx !== -1) global.downloadListeners[event].splice(idx, 1)
    }
}

/**
 * 清空下载队列(不清除状态)
 */
export function clearDownloadQueue() {
    global.downloadQueue = []
}

/**
 * 重置下载状态
 */
export function resetDownloadStatus() {
    global.downloadQueue = []
    global.downloadStatus = { total: 0, completed: 0, failed: 0, running: 0 }
}