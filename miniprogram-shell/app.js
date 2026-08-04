App({
  onLaunch() {
    if (!wx.cloud) { console.warn('当前基础库不支持云开发'); return }
    wx.cloud.init({ env: 'pintu-d4g77ecn24b674fa0', traceUser: true })
  }
})
