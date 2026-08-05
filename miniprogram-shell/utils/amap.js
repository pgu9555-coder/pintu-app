// AMap Web Service access is deliberately opt-in.  Do not put a key in source:
// the integrator supplies one through app.globalData.amapMiniKey (or amap.key).
// `restapi.amap.com` must also be added to the Mini Program request-domain list.

function configuredKey() {
  const app = typeof getApp === 'function' ? getApp() : null
  const globalData = (app && app.globalData) || {}
  const config = globalData.amap || globalData.mapConfig || {}
  const key = globalData.amapMiniKey || config.miniKey || config.key || ''
  return /^[0-9a-z]{16,}$/i.test(String(key)) ? String(key) : ''
}

function unavailable(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function request(path, data) {
  const key = configuredKey()
  if (!key) {
    return Promise.reject(unavailable(
      'AMAP_KEY_MISSING',
      '地图搜索尚未配置。请使用地图选点，或由管理员配置 app.globalData.amapMiniKey。'
    ))
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: `https://restapi.amap.com${path}`,
      data: Object.assign({ key }, data || {}),
      success(response) {
        const body = response && response.data
        if (body && String(body.status) === '1') {
          resolve(body)
          return
        }
        reject(unavailable('AMAP_UNAVAILABLE', (body && body.info) || '地图搜索暂时不可用。'))
      },
      fail() {
        reject(unavailable('AMAP_UNAVAILABLE', '地图搜索不可用；请检查网络和 request 合法域名，或使用地图选点。'))
      }
    })
  })
}

function normalizeTip(item, index) {
  const location = String((item && item.location) || '').split(',')
  const lng = Number(location[0])
  const lat = Number(location[1])
  if (!item || !item.name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const detail = [item.district, item.address].filter(Boolean).join(' ').trim()
  return {
    id: String(item.id || `${item.name}-${lat}-${lng}-${index}`),
    name: String(item.name).slice(0, 80),
    address: detail || String(item.name).slice(0, 120),
    lat,
    lng
  }
}

function inputTips(keywords) {
  const query = String(keywords || '').trim()
  if (query.length < 2) return Promise.resolve([])
  return request('/v3/assistant/inputtips', { keywords: query, citylimit: 'false', datatype: 'all' })
    .then((body) => (body.tips || []).map(normalizeTip).filter(Boolean).slice(0, 10))
}

function optionalText(value, maxLength) {
  const first = Array.isArray(value) ? value[0] : value
  if (first == null || typeof first === 'object') return ''
  const text = String(first).trim()
  if (!text || text === '[]' || text.toLowerCase() === 'null') return ''
  return text.slice(0, maxLength)
}

function nearby(center) {
  const latitude = Number(center && center.latitude)
  const longitude = Number(center && center.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return Promise.resolve([])
  return request('/v3/place/around', {
    location: `${longitude},${latitude}`,
    keywords: '商场 餐饮 咖啡 茶饮',
    radius: 5000,
    offset: 12,
    extensions: 'all'
  }).then((body) => (body.pois || []).map((poi, index) => {
    const point = String(poi.location || '').split(',')
    const lng = Number(point[0])
    const lat = Number(point[1])
    if (!poi.name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
    const address = optionalText(poi.address, 120)
    const category = optionalText(poi.type, 120)
    const business = poi.biz_ext && typeof poi.biz_ext === 'object' ? poi.biz_ext : {}
    const rating = optionalText(business.rating, 16)
    const averageCost = optionalText(business.cost, 16)
    return {
      id: `amap-${poi.id || `${poi.name}-${lat}-${lng}-${index}`}`,
      name: String(poi.name).slice(0, 80),
      lat,
      lng,
      typeStr: [address.slice(0, 72), category.slice(0, 44)].filter(Boolean).join(' · ').slice(0, 120) || '附近地点',
      address,
      category,
      phone: optionalText(poi.tel, 80),
      rating,
      averageCost
    }
  }).filter(Boolean))
}

module.exports = { configuredKey, inputTips, nearby }
