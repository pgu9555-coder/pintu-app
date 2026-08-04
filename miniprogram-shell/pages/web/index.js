const H5_URL = 'https://pintu-d4g77ecn24b674fa0-1303073868.tcloudbaseapp.com/index.html'

Page({
  data: {
    url: H5_URL
  },

  onWebViewLoad(event) {
    console.info('[拼途 web-view] 加载完成', event.detail)
  },

  onWebViewError(event) {
    console.error('[拼途 web-view] 加载失败', event.detail)
  }
})
