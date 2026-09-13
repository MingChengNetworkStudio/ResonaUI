/******************************************************************************
 * @file        useful.js
 * @description 通用工具函数模块
 * @author      B4QAQ
 * @source      ResonaUI
 * @version     1.2
 * @copyright   2026 B4QAQ@MCNS.
 * @license     MIT
 ******************************************************************************/

import device from '@system.device'
import network from '@system.network'
import app from '@system.app'
import * as storageManager from './storage.js'

/**
 * 获取设备信息
 * @return {Promise<Object>} 设备信息对象
 */
export async function getDeviceInfo() {
  const info = {}
  console.log('[+]开始获取设备信息...')

  try {
    await new Promise((resolve) => {
      device.getInfo({
        success: (data) => { Object.assign(info, data); resolve() },
        fail: () => resolve()
      })
    })

    await new Promise((resolve) => {
      device.getDeviceId({
        success: (data) => { Object.assign(info, data); resolve() },
        fail: () => resolve()
      })
    })

    await new Promise((resolve) => {
      device.getSerial({
        success: (data) => { Object.assign(info, data); resolve() },
        fail: () => resolve()
      })
    })

    await new Promise((resolve) => {
      network.getType({
        success: (data) => {
          if (global.NetworkStatus === 'bridge') {
            info.type = 'bridge'
            global.fetchAva = true
          } else {
            Object.assign(info, data)
          }
          resolve()
        },
        fail: () => resolve()
      })
    })

    Object.assign(info, app.getInfo())
    if (global.NetworkStatus !== 'bridge') {
      global.fetchAva = !!app.canIUse('@system.fetch')
    }
    global.Screen = {
      screenWidth: info.screenWidth,
      screenHeight: info.screenHeight,
      screenShape: info.screenShape
    }
    global.NetworkStatus = info.type
  } catch (e) {
    console.error('[X] 获取设备信息失败:', e)
  }

  return info
}

/**
 * 获取设置并更新全局变量
 * @return {Promise<Object>} 设置对象
 */
export async function getSettings() {
  let settings = {}
  console.log('[+]开始更新全局设置项...')

  try {
    settings = await storageManager.getSettings()
    global.APIKey = settings.APIKey
    global.AdmSet = settings['动画选项']
  } catch (e) {
    console.log('[X]全局设置更新失败:', e)
    settings = {}
  }

  return settings
}

/**
 * 初始化键盘事件处理
 * @description 为页面提供完整的键盘输入、光标操作、选区操作功能
 * @param {Object} vm - 页面组件实例 (this)
 * @param {string} scrollId - 滚动容器元素 id，默认 'mainScl'
 *
 * @example
 * // 在页面顶部引入组件，如：<import name="input-method" src="../../components/InputMethod/InputMethod"></import>
 * // 在页面中声明以下变量：
 * showKeyboard: false,
 * currentField: null,
 * textParts: { toEmail: ['', ''], subject: ['', ''], content: ['', ''] },
 * anchor: null,
 * preferredColumn: -1,
 * // 在主scroll上绑定好ID后,在页面 onInit 中使用
 * onInit() {
 *   initKeyboard(this,scrollId)
 * }
 * 即可便捷，快速的添加键盘组件
 *
 */
export function initKeyboard(vm, scrollId = 'mainScl') {
  // ==================== 工具方法 ====================

  /**
   * 获取当前光标位置（字符偏移量）
   */
  vm.getCursorPosition = function() {
    const parts = this.textParts[this.currentField]
    return parts ? parts[0].length : 0
  }

  /**
   * 根据位置设置光标
   */
  vm.setCursorPosition = function(position) {
    const parts = this.textParts[this.currentField]
    if (!parts) return
    const fullText = parts.join('')
    const safePos = Math.max(0, Math.min(position, fullText.length))
    parts[0] = fullText.slice(0, safePos)
    parts[1] = fullText.slice(safePos)
  }

  /**
   * 获取选区文本
   */
  vm.getSelectedText = function() {
    if (this.anchor === null) {
      return null
    }
    const parts = this.textParts[this.currentField]
    if (!parts) return null
    const cursorPos = parts[0].length
    const anchorPos = this.anchor
    const start = Math.min(anchorPos, cursorPos)
    const end = Math.max(anchorPos, cursorPos)
    const fullText = parts.join('')
    return {
      text: fullText.slice(start, end),
      start,
      end,
      anchorPos,
      cursorPos
    }
  }

  /**
   * 获取显示文本（带选区高亮和光标）
   */
  vm.getDisplayText = function(field) {
    const parts = this.textParts[field]
    if (!parts) return ''
    const fullText = parts.join('')

    // 无内容且非当前字段，显示占位符
    if (!fullText && this.currentField !== field) {
      return '点击输入'
    }

    // 当前字段且有选区
    if (this.currentField === field && this.anchor !== null) {
      const cursorPos = parts[0].length
      const anchorPos = this.anchor
      const start = Math.min(anchorPos, cursorPos)
      const end = Math.max(anchorPos, cursorPos)
      return fullText.slice(0, start) + '[' + fullText.slice(start, end) + ']' + fullText.slice(end)
    }

    // 当前字段无选区，显示光标
    if (this.currentField === field) {
      return parts[0] + (this.showKeyboard ? '|' : '') + parts[1]
    }

    // 非当前字段
    return fullText
  }

  // ==================== 事件处理方法 ====================

  /**
   * 聚焦输入框
   */
  vm.focusInput = function(field) {
    if (this.currentField === field) {
      this.showKeyboard = false
      this.currentField = null
      this.anchor = null
      this.preferredColumn = -1
      return
    }
    this.currentField = field
    this.showKeyboard = true
    this.anchor = null
    this.preferredColumn = -1

    // 滚动到当前输入框（输入框元素 id = 字段名）
    const fieldEl = this.$element(field)
    const scrollEl = this.$element(scrollId)
    if (fieldEl && scrollEl) {
      fieldEl.getBoundingClientRect({
        success: (data) => {
          const { top } = data
          const moveY = top - 60
          scrollEl.scrollBy({
            top: moveY,
            left: 0,
            behavior: 'smooth'
          })
        },
        fail: (errorData, errorCode) => {
          console.log(`[E${errorCode}] 无法自动滚动: ${JSON.stringify(errorData)}`)
          global.uiAdm.MessageBox(`[E${errorCode}] 无法自动滚动: ${JSON.stringify(errorData)}`)
        }
      })
    }
  }

  /**
   * 输入完成
   */
  vm.onInputComplete = function(evt) {
    this.anchor = null
    this.textParts[this.currentField][0] += evt.detail.content
  }

  /**
   * 删除
   */
  vm.onInputDelete = function() {
    const parts = this.textParts[this.currentField]
    if (!parts) return

    const selection = this.getSelectedText()
    if (selection) {
      const fullText = parts.join('')
      parts[0] = fullText.slice(0, selection.start)
      parts[1] = fullText.slice(selection.end)
      this.anchor = null
      return
    }

    if (parts[0].length > 0) {
      parts[0] = parts[0].slice(0, -1)
    }
  }

  /**
   * 光标移动
   */
  vm.onCursorMove = function(evt) {
    const parts = this.textParts[this.currentField]
    if (!parts) return
    const direction = evt.detail.direction

    // 获取当前行的列位置
    const getLastLinePrefix = (text) => {
      const lastNl = text.lastIndexOf('\n')
      return lastNl === -1 ? text : text.slice(lastNl + 1)
    }

    switch(direction) {
      case 'left':
        this.preferredColumn = -1
        if (parts[0].length > 0) {
          parts[1] = parts[0].slice(-1) + parts[1]
          parts[0] = parts[0].slice(0, -1)
        }
        break

      case 'right':
        this.preferredColumn = -1
        if (parts[1].length > 0) {
          parts[0] += parts[1].slice(0, 1)
          parts[1] = parts[1].slice(1)
        }
        break

      case 'up':
        const currLineStart = parts[0].lastIndexOf('\n')
        const currLinePrefix = getLastLinePrefix(parts[0])

        if (this.preferredColumn === -1) {
          this.preferredColumn = currLinePrefix.length
        }

        if (currLineStart === -1) {
          parts[1] = parts[0] + parts[1]
          parts[0] = ''
        } else {
          const prevPart = parts[0].slice(0, currLineStart)
          const prevLineStart = prevPart.lastIndexOf('\n')
          const prevLine = prevLineStart === -1 ? prevPart : prevPart.slice(prevLineStart + 1)
          const offset = Math.min(this.preferredColumn, prevLine.length)
          parts[0] = (prevLineStart === -1 ? '' : prevPart.slice(0, prevLineStart + 1)) + prevLine.slice(0, offset)
          parts[1] = prevLine.slice(offset) + '\n' + currLinePrefix + parts[1]
        }
        break

      case 'down':
        const nextNl = parts[1].indexOf('\n')

        if (this.preferredColumn === -1) {
          this.preferredColumn = getLastLinePrefix(parts[0]).length
        }

        if (nextNl === -1) {
          parts[0] = parts[0] + parts[1]
          parts[1] = ''
        } else {
          const currLineRemainder = parts[1].slice(0, nextNl)
          const afterNl = parts[1].slice(nextNl + 1)
          const nextNl2 = afterNl.indexOf('\n')
          const nextLine = nextNl2 === -1 ? afterNl : afterNl.slice(0, nextNl2)
          const rest = nextNl2 === -1 ? '' : afterNl.slice(nextNl2 + 1)
          const offset2 = Math.min(this.preferredColumn, nextLine.length)

          parts[0] = parts[0] + currLineRemainder + '\n' + nextLine.slice(0, offset2)
          parts[1] = nextLine.slice(offset2) + (rest.length > 0 ? '\n' + rest : '')
        }
        break
    }
  }

  /**
   * 开始选择
   */
  vm.onCursorSelect = function() {
    if (this.anchor !== null) {
      this.anchor = null
    } else {
      this.anchor = this.getCursorPosition()
    }
  }

  /**
   * 复制
   */
  vm.onCopy = function() {
    const selection = this.getSelectedText()

    if (selection) {
      if (!global.paste) global.paste = {}
      global.paste.text = selection.text
      global.paste.type = 'text'
    } else {
      if (!global.paste) global.paste = {}
      const parts = this.textParts[this.currentField]
      global.paste.text = parts.join('')
      global.paste.type = 'text'
    }
  }

  /**
   * 粘贴
   */
  vm.onPaste = function() {
    if (!global.paste || !global.paste.text) return

    const parts = this.textParts[this.currentField]
    if (!parts) return

    const selection = this.getSelectedText()
    if (selection) {
      const fullText = parts.join('')
      parts[0] = fullText.slice(0, selection.start) + global.paste.text
      parts[1] = fullText.slice(selection.end)
      this.anchor = null
    } else {
      parts[0] += global.paste.text
    }
  }

  /**
   * 剪切
   */
  vm.onCut = function() {
    const selection = this.getSelectedText()

    if (selection) {
      if (!global.paste) global.paste = {}
      global.paste.text = selection.text
      global.paste.type = 'text'

      const parts = this.textParts[this.currentField]
      const fullText = parts.join('')
      parts[0] = fullText.slice(0, selection.start)
      parts[1] = fullText.slice(selection.end)
      this.anchor = null
    } else {
      if (!global.paste) global.paste = {}
      const parts = this.textParts[this.currentField]
      global.paste.text = parts.join('')
      global.paste.type = 'text'
      this.textParts[this.currentField] = ['', '']
    }
  }

  /**
   * 全选
   */
  vm.onSelectAll = function() {
    this.anchor = 0
    const parts = this.textParts[this.currentField]
    if (!parts) return
    const fullText = parts.join('')
    parts[0] = fullText
    parts[1] = ''
  }

  /**
   * 切换键盘显示状态
   * @description 有键盘则隐藏键盘，无键盘则返回上一页
   */
  vm.toggleKeyboard = function() {
    if (this.showKeyboard) {
      this.showKeyboard = false
    } else {
      this.back()
    }
  }

  console.log('[initKeyboard] 键盘事件处理已初始化')
}