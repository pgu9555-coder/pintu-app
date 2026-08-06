// Map search is mediated by the CloudBase gateway.  This module intentionally
// contains no provider key, provider URL, or request-domain dependency.

function configuredKey() {
  // Kept for the existing UI contract: the server owns map configuration.
  return true
}

function unavailable(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function call(action, data) {
  if (typeof wx !== 'object' || !wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    return Promise.reject(unavailable('MAP_UNAVAILABLE', '地图搜索暂时不可用，请使用地图选点。'))
  }
  return wx.cloud.callFunction({
    name: 'mapGateway',
    data: Object.assign({ action }, data || {})
  }).then((response) => {
    const result = response && response.result
    if (result && result.ok) return result.data
    throw unavailable(
      (result && result.code) || 'MAP_UNAVAILABLE',
      (result && result.message) || '地图搜索暂时不可用，请使用地图选点。'
    )
  }).catch((error) => {
    if (error && error.code) throw error
    throw unavailable('MAP_UNAVAILABLE', '地图搜索暂时不可用，请使用地图选点。')
  })
}

function inputTips(keywords) {
  const query = String(keywords || '').trim()
  if (query.length < 2) return Promise.resolve([])
  return call('inputTips', { keywords: query }).then((data) => Array.isArray(data) ? data : [])
}

function nearby(center) {
  const latitude = Number(center && center.latitude)
  const longitude = Number(center && center.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return Promise.resolve([])
  return call('nearby', { latitude, longitude }).then((data) => Array.isArray(data) ? data : [])
}

module.exports = { configuredKey, inputTips, nearby }
