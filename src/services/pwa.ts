/** 在 HTTPS 页面注册离线缓存；iOS Safari 通过“添加到主屏幕”获得独立窗口体验。 */
export const registerPwa = () => {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(window.location.protocol)) {
    return
  }
  window.addEventListener(
    'load',
    () => {
      void navigator.serviceWorker.register('./sw.js').catch(() => {
        // PWA 安装不应影响主应用启动；离线能力不可用时仍可在线使用。
      })
    },
    { once: true }
  )
}
