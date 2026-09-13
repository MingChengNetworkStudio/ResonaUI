/******************************************************************************
 * @file        storage.js
 * @description 数据存储与管理模块
 * @author      B4QAQ
 * @source      ResonaUI
 * @version     6.0
 * @copyright   2026 B4QAQ@MCNS.
 * @license     MIT
 ******************************************************************************/

import file from '@system.file'

const BASE_PATH = 'internal://files/mail'
const SETTINGS_FILE_PATH = BASE_PATH + '/settings.json'

// ==================== 初始化 ====================

/**
 * 初始化存储系统
 */
export async function init() {
    try {
        await createDir(BASE_PATH, '基础目录')
        console.log('[✓]存储目录初始化完成')
    } catch (error) {
        console.log('[X]存储目录初始化失败:', error)
    }
}

/**
 * 创建目录
 */
function createDir(path, name) {
    return new Promise((resolve, reject) => {
        file.mkdir({
            uri: path,
            recursive: true,
            success: () => resolve(),
            fail: (data, code) => code === 300 ? resolve() : reject(`创建${name}失败: ${code}`)
        })
    })
}

// ==================== 工具函数 ====================

function readJsonFile(path) {
    return new Promise((resolve) => {
        file.readText({
            uri: path,
            success: (data) => {
                try {
                    resolve(JSON.parse(data.text))
                } catch (e) {
                    resolve(null)
                }
            },
            fail: () => resolve(null)
        })
    })
}

function writeJsonFile(path, data) {
    return new Promise((resolve, reject) => {
        file.writeText({
            uri: path,
            text: JSON.stringify(data),
            success: () => resolve(true),
            fail: (data, code) => reject(`写入失败: ${code}`)
        })
    })
}

export function deleteDir(path) {
    return new Promise((resolve) => {
        file.rmdir({
            uri: path,
            recursive: true,
            success: () => resolve(true),
            fail: () => resolve(false)
        })
    })
}

// ==================== 设置相关 ====================

export async function getSettings() {
    try {
        const data = await readJsonFile(SETTINGS_FILE_PATH)
        return data || {}
    } catch (e) {
        return {}
    }
}

export async function saveSettings(settingsObj) {
    const currentSettings = await getSettings()
    const mergedSettings = { ...currentSettings, ...settingsObj }
    await writeJsonFile(SETTINGS_FILE_PATH, mergedSettings)
    return { code: 200 }
}