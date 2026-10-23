function headerMetrics() {
  const systemInfo = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
  const statusBarPx = Number(systemInfo.statusBarHeight || 20)
  let capsule = null
  try { capsule = wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect() } catch (_) {}
  const height = capsule && capsule.height ? Number(capsule.height) : 32
  const capsuleTopPx = capsule && capsule.top ? Number(capsule.top) : statusBarPx + 6
  const capsuleBottomPx = capsule && capsule.bottom ? Number(capsule.bottom) : capsuleTopPx + height
  const screenWidthPx = Number(systemInfo.windowWidth || systemInfo.screenWidth || 375)
  const capsuleInsetRightPx = capsule && capsule.left ? Math.max(44, screenWidthPx - Number(capsule.left)) : 96
  return { statusBarPx, headerHeightPx: Math.max(44, capsuleBottomPx - statusBarPx), capsuleTopPx, capsuleBottomPx, capsuleInsetRightPx }
}

function headerTopPx() {
  const metrics = headerMetrics()
  return metrics.statusBarPx + metrics.headerHeightPx
}

module.exports = { headerMetrics, headerTopPx }
