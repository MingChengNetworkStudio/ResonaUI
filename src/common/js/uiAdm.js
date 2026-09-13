/******************************************************************************
 * @file        uiAdm.js
 * @description 应用UI管理JS
 * @author      B4QAQ
 * @source      ResonaUI
 * @version     1.5
 * @copyright   2026 B4QAQ@MCNS.
 * @license     MPL-2.0-only
 ******************************************************************************/

import prompt from '@system.prompt'
import router from '@system.router'

// 动画常量配置
const ANIM_CONFIG = {
  BACK_DELAY: 150,
  CLEAR_DELAY: 500,
  GC_INTERVAL: 10000,
  CLASSES: {
    OPEN: 'scroll',
    BACK: 'scroll-backanim',
    FROM_BACK: 'scroll-frombackanim'
  }
}

// 初始化全局对象
if (!global.pagePool) global.pagePool = new Map()
if (!global.messageLock) global.messageLock = false

/**
 * 初始化UI管理系统
 */
export function initAdm() {
  console.log('[UI-Adm] Initializing...')
  setInterval(() => {
    global.pagePool.forEach((vm, name) => {
      if (vm && !vm.$valid) {
        global.pagePool.delete(name)
        console.log(`[UI-Adm] GC: ${name}`)
      }
    })
  }, ANIM_CONFIG.GC_INTERVAL)
}

/**
 * 更新所有页面的时间显示
 */
export function UpdateTime(timeStr) {
  global.pagePool.forEach(vm => {
    if (vm.NowTime !== timeStr) vm.NowTime = timeStr
  })
}

/**
 * 注册页面
 */
export function registerPage(pageName, vm) {
  global.pagePool.set(pageName, vm)
  vm.scrclass = shouldEnableAnimations() ? ANIM_CONFIG.CLASSES.OPEN : ''
  // 注册页面的route和back方法
  vm.route = (pageName,params) =>{
    router.push({ uri: `/pages/${pageName}`, params })
  }
  vm.back = () => {
    handleBackPress(() => router.back())
    global.runGC()
  }
  vm.NowTime = global.NowHour + ':' + global.NowMin
  console.log(`[UI-Adm] Registered: ${pageName}`)
}

/**
 * 注销页面
 */
export function unregisterPage(pageName) {
  global.pagePool.delete(pageName)
  console.log(`[UI-Adm] Unregistered: ${pageName}`)
}

/**
 * 显示提示框
 */
export function MessageBox(text = '未指定文本', time = 1500) {
  prompt.showToast({ message: text, duration: time })
}

/**
 * 处理返回动画
 */
export function handleBackPress(onBackComplete) {
  if (!shouldEnableAnimations()) {
    onBackComplete()
    return
  }

  let currentPageName = ''
  let prevPageName = ''

  try {
    const pages = router.getPages()
    if (pages.length >= 1) currentPageName = pages[pages.length - 1].name || ''
    if (pages.length >= 2) prevPageName = pages[pages.length - 2].name || ''
  } catch (e) {
    const pageNames = Array.from(global.pagePool.keys())
    if (pageNames.length >= 1) currentPageName = pageNames[pageNames.length - 1]
    if (pageNames.length >= 2) prevPageName = pageNames[pageNames.length - 2]
  }

  if (!currentPageName) {
    onBackComplete()
    return
  }

  setClass(currentPageName, ANIM_CONFIG.CLASSES.BACK)

  setTimeout(() => {
    setClass(currentPageName, '')
    onBackComplete()

    if (prevPageName) {
      setClass(prevPageName, '')
      setClass(prevPageName, ANIM_CONFIG.CLASSES.FROM_BACK)
      setTimeout(() => setClass(prevPageName, ''), ANIM_CONFIG.CLEAR_DELAY)
    }
  }, ANIM_CONFIG.BACK_DELAY)
}

function setClass(pageName, className) {
  const vm = global.pagePool.get(pageName)
  if (vm) vm.scrclass = className
}

function shouldEnableAnimations() {
  try {
    return global.AdmSet >= 1
  } catch (e) {
    return false
  }
}