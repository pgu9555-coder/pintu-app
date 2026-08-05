function headerTopPx() {
  const systemInfo = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
  let top = Number(systemInfo.statusBarHeight || 20) + 52
  try {
    const menuButton = wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect()
    if (menuButton && menuButton.bottom) top = Number(menuButton.bottom) + 8
  } catch (_) {}
  return top
}

module.exports = { headerTopPx }
