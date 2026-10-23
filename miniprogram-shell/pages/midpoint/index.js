const transferOwnership = require('../../utils/ownership')
const gateway = require('../../services/roomGateway')
const storage = require('../../utils/storage')
const midpoint = require('../../utils/midpoint')
const layout = require('../../utils/layout')
const amap = require('../../utils/amap')
const invite = require('../../utils/invite')
const LOCAL_MIDPOINT_KEY = 'pintu-local-midpoint-v2'
const PENDING_CREATE_KEY = 'pintu-midpoint-pending-create-v1'
const POINT_OUTBOX_PREFIX = 'pintu-midpoint-point-outbox-v1:'
const MAX_LOCAL_POINTS = 6

function localFriendLetter(index) {
  return String.fromCharCode(66 + index)
}

function hasLocalCoordinates(point) {
  const lat = point && point.lat
  const lng = point && point.lng
  if (lat === null || lat === undefined || lng === null || lng === undefined) return false
  if (typeof lat === 'boolean' || typeof lng === 'boolean') return false
  if ((typeof lat === 'string' && !lat.trim()) || (typeof lng === 'string' && !lng.trim())) return false
  const latitude = Number(lat)
  const longitude = Number(lng)
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
}

function isUntouchedLegacyPoints(points) {
  if (!Array.isArray(points) || points.length !== 2) return false
  return points.every((point, index) => {
    if (String(point && point.id || '') !== `local-${index + 1}`) return false
    const name = String(point && point.name || '').trim()
    const address = String(point && point.address || '').trim()
    return !hasLocalCoordinates(point) && !address && (!name || name === `地点 ${index + 1}`)
  })
}

function localPointLabel(point, index, profile) {
  if (index === 0) return String((profile && profile.nickname) || point && point.label || '我').trim() || '我'
  return `朋友 ${localFriendLetter(index - 1)}`
}

function localPointInitial(point, index) {
  return index === 0 ? '我' : localFriendLetter(index - 1)
}

function normalizeLocalPoints(points, profile) {
  const source = Array.isArray(points) ? points : []
  const rows = isUntouchedLegacyPoints(source) ? [] : source.slice(0, MAX_LOCAL_POINTS)
  const base = rows.length ? rows : [{}, {}]
  if (base.length === 1) base.push({})
  return base.map((point, index) => {
    const isSelf = index === 0
    return {
      id: isSelf ? 'local-self' : String(point && point.id || `local-friend-${index}`),
      isSelf,
      label: localPointLabel(point, index, profile),
      name: String(point && point.name || '').slice(0, 48),
      initial: localPointInitial(point, index),
      avatarFileId: isSelf ? String(profile && profile.avatarFileId || '') : '',
      address: String(point && point.address || '').slice(0, 120),
      lat: hasLocalCoordinates(point) ? Number(point.lat) : null,
      lng: hasLocalCoordinates(point) ? Number(point.lng) : null
    }
  })
}

function emptyLocalPoints() {
  return normalizeLocalPoints([])
}

function validLocalState(value, profile) {
  const points = value && Array.isArray(value.points) ? value.points : []
  const candidates = value && Array.isArray(value.candidates) ? value.candidates : []
  return {
    points: normalizeLocalPoints(points, profile),
    candidates: candidates.slice(0, 12)
  }
}

function distanceMeters(from, to) {
  if (!from || !to) return 0
  const rad = (value) => value * Math.PI / 180
  const lat1 = rad(Number(from.latitude))
  const lat2 = rad(Number(to.lat))
  const dLat = lat2 - lat1
  const dLng = rad(Number(to.lng) - Number(from.longitude))
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

function cleanCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, '')
    .slice(0, 8)
}

function roomInput(name) {
  return {
    name: `${name}发起的碰面`,
    toolType: 'midpoint',
    members: [{ name }]
  }
}

function requestId() {
  return `mini_midpoint_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function pointOutboxKey(docId) {
  return `${POINT_OUTBOX_PREFIX}${String(docId || '')}`
}

function validPendingCreate(value) {
  if (!value || typeof value !== 'object' || typeof value.requestId !== 'string') return null
  if (!/^mini_midpoint_[a-z0-9_]{12,80}$/i.test(value.requestId)) return null
  return { requestId: value.requestId, name: String(value.name || '').slice(0, 24) }
}

function validPendingMeetupMutation(value, docId) {
  if (!value || typeof value !== 'object' || value.docId !== docId) return null
  const membershipEpoch = String(value.membershipEpoch || '')
  const mutationAt = Math.floor(Number(value.mutationAt))
  if (!membershipEpoch || !Number.isFinite(mutationAt) || mutationAt <= 0) return null
  if (value.person == null) return { docId, membershipEpoch, mutationAt, person: null }
  const person = value.person
  const name = String(person.name || '').trim().slice(0, 24)
  const address = String(person.address || '').trim().slice(0, 200)
  const lat = Number(person.lat)
  const lng = Number(person.lng)
  if (!name || !address || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { docId, membershipEpoch, mutationAt, person: { name, address, lat, lng } }
}

function candidateDetailKey(candidate) {
  const name = String(candidate && candidate.name || '').trim().toLocaleLowerCase('zh-CN')
  const lat = Number(candidate && candidate.lat)
  const lng = Number(candidate && candidate.lng)
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return ''
  return `${name}|${lat.toFixed(6)}|${lng.toFixed(6)}`
}

function currentDecision(room) {
  const source = (room && room.meetup && room.meetup.decision) || {}
  return {
    roundId: typeof source.roundId === 'string' ? source.roundId : '',
    revision: Number.isFinite(Number(source.revision)) ? Number(source.revision) : 0,
    state: source.state === 'confirmed' ? 'confirmed' : 'open',
    candidates: Array.isArray(source.candidates) ? source.candidates : [],
    votes: Array.isArray(source.votes) ? source.votes : [],
    confirmedCandidateId: typeof source.confirmedCandidateId === 'string' ? source.confirmedCandidateId : ''
  }
}

function decisionCandidates(decision, viewer, room, detailsByKey) {
  const uid = viewer && viewer.uid
  const memberUids = new Set(((room && room.members) || []).map((member) => member && member.uid).filter(Boolean))
  const restrictToMembers = memberUids.size > 0
  const votes = decision.votes.filter((vote) => vote &&
    (!restrictToMembers || memberUids.has(vote.uid)) && /^(want|ok|no)$/.test(vote.value || ''))
  const rows = decision.candidates.map((candidate) => {
    const candidateVotes = votes.filter((vote) => vote.candidateId === candidate.id)
    const details = (detailsByKey && detailsByKey[candidateDetailKey(candidate)]) || {}
    const myVote = (candidateVotes.find((vote) => vote.uid === uid) || {}).value || ''
    const wantVotes = candidateVotes.filter((vote) => vote.value === 'want').length
    const okVotes = candidateVotes.filter((vote) => vote.value === 'ok').length
    const noVotes = candidateVotes.filter((vote) => vote.value === 'no').length
    return Object.assign({}, candidate, details, {
      address: details.address || candidate.address || candidate.typeStr || '',
      category: details.category || candidate.category || '',
      wantVotes,
      okVotes,
      noVotes,
      voteTotal: candidateVotes.length,
      score: wantVotes * 2 + okVotes - noVotes * 2,
      myVote,
      wantSelected: myVote === 'want',
      okSelected: myVote === 'ok',
      noSelected: myVote === 'no',
      isConfirmed: decision.confirmedCandidateId === candidate.id
    })
  })
  rows.sort((a, b) => b.score - a.score || a.noVotes - b.noVotes || b.wantVotes - a.wantVotes || b.voteTotal - a.voteTotal || String(a.name).localeCompare(String(b.name), 'zh-CN'))
  return rows.map((candidate, index) => Object.assign({}, candidate, {
    isConsensusLeader: decision.state !== 'confirmed' && index === 0 && candidate.voteTotal > 0
  }))
}

function decisionParticipation(decision, room) {
  const memberUids = new Set(((room && room.members) || []).map((member) => member && member.uid).filter(Boolean))
  const candidateIds = new Set(decision.candidates.map((candidate) => candidate && candidate.id).filter(Boolean))
  const voters = new Set(decision.votes.filter((vote) => vote && candidateIds.has(vote.candidateId) && /^(want|ok|no)$/.test(vote.value || '') && (!memberUids.size || memberUids.has(vote.uid))).map((vote) => vote.uid))
  return { voters: voters.size, members: memberUids.size }
}

function locationCandidate(location) {
  const address = String(location.address || location.name || '地图选择地点').slice(0, 120)
  return {
    name: String(location.name || location.address || '地图地点').slice(0, 80),
    lat: Number(location.latitude),
    lng: Number(location.longitude),
    typeStr: address,
    address,
    category: '',
    dist: 0,
    isMall: false,
    isDrink: false
  }
}

function requirePrivacyAuthorization() {
  return new Promise((resolve, reject) => {
    if (!wx.getPrivacySetting) {
      resolve()
      return
    }
    wx.getPrivacySetting({
      success(result) {
        if (!result.needAuthorization) {
          resolve()
          return
        }
        if (!wx.requirePrivacyAuthorize) {
          const error = new Error('请先同意隐私保护指引')
          error.code = 'PRIVACY_REQUIRED'
          reject(error)
          return
        }
        wx.requirePrivacyAuthorize({
          success: resolve,
          fail(error) {
            const privacyError = new Error('请先同意隐私保护指引')
            privacyError.code = 'PRIVACY_REQUIRED'
            privacyError.cause = error
            reject(privacyError)
          }
        })
      },
      fail: reject
    })
  })
}

function presentationPoi(poi) {
  const category = poi.isMall ? 'mall' : poi.isDrink ? 'drink' : 'food'
  const photo = Array.isArray(poi.photos) && poi.photos.find(item => /^https:\/\//.test(String(item && item.url || item || '')))
  return Object.assign({}, poi, { categoryKey: category, cover: photo ? String(photo.url || photo) : '/assets/categories/' + category + '.png', fallbackCover: '/assets/categories/' + category + '.png', dist: Number(poi.dist) || 0 })
}
function normalizeSearchPlaces(places, center) {
  return places.slice(0, 12).map((place, i) => Object.assign({}, place, {
    id: place.id || place.poiId || 'nearby-' + i,
    dist: distanceMeters(center, place),
    isMall: typeof place.isMall === 'boolean' ? place.isMall : /商场|购物/.test(place.typeStr || ''),
    isDrink: typeof place.isDrink === 'boolean' ? place.isDrink : /咖啡|茶艺|冷饮|奶茶/.test((place.typeStr || '') + (place.name || ''))
  }))
}

Page({
  data: {
    name: '',
    accountAvatar: '',
    code: '',
    room: null,
    people: [],
    center: null,
    markers: [],
    decision: currentDecision(null),
    decisionCandidates: [],
    decisionConfirmed: false,
    decisionParticipantCount: 0,
    decisionMemberCount: 0,
    confirmedCandidate: null,
    localPoints: emptyLocalPoints(),
    localCandidates: [],
    localCalculated: false,
    localStorageMessage: '',
    localPointEditorId: '',
    localPointEditorLabel: '',
    localAddressQuery: '',
    localAddressSuggestions: [],
    localAddressSearchLoading: false,
    localAddressMessage: '',
    localAddressError: false,
    mapSearchMessage: '',
    mineName: '',
    mineAddress: '',
    mineEditorOpen: false,
    mineLocation: null,
    mineHasSavedLocation: false,
    pointSyncPending: false,
    pointSyncBusy: false,
    pointSyncText: '',
    addressSuggestions: [],
    addressSuggestionsVisible: false,
    addressSearchLoading: false,
    amapConfigured: false,
    screen: 'main',
    resultMode: false, filter: 'all', resultRows: [], resultCount: 0, polyline: [], mapFitPoints: [], mapScale: 12, expandedPoiId: '', mapLoading: false, mapError: '', swipeDetail: null,
    swipeDeck: [],
    swipeIndex: 0,
    swipeCurrent: null,
    swipeLikes: [],
    swipeFinished: false,
    swipeFlipped: false,
    swipeDragX: 0,
    swipeCardStyle: '',
    swipeVoteBusy: false,
    headerTopPx: 72,
    isOwner: false,
    busy: false,
    syncText: '已同步'
  },

  present(patch, callback) {
    const next = Object.assign({}, this.data, patch)
    const source = next.room ? next.decisionCandidates : next.localCandidates
    const rows = (source || []).map(poi => {
      const details = (this.poiDetails || {})[candidateDetailKey(poi)] || {}
      const row = presentationPoi(Object.assign({},poi,{photos:details.loaded && details.info && details.info.photos || poi.photos}))
      if (this.failedCovers && this.failedCovers.has(candidateDetailKey(poi))) row.cover = row.fallbackCover
      return Object.assign(row, { expanded: String(poi.id) === String(next.expandedPoiId), details })
    })
    const resultRows = rows.filter(row => next.filter === 'all' || row.categoryKey === next.filter)
    const polyline = next.center ? (next.markers || []).filter(marker => marker.id !== 9999).map((marker, i) => ({
      points: [{latitude: marker.latitude, longitude: marker.longitude}, next.center], color: ['#ee9476aa','#638b68aa','#799ba4aa','#bd9b68aa'][i % 4], width: 2, dottedLine: true
    })) : []
    const derived = {resultRows,resultCount:rows.length,polyline}
    if (Object.prototype.hasOwnProperty.call(patch,'markers')) derived.mapFitPoints = (next.markers || []).map(marker => ({latitude:marker.latitude,longitude:marker.longitude}))
    this.setData(Object.assign({},patch,derived),callback)
  },

  adjustPlaces() {
    this.adjustingPlaces = true
    this.localSearchVersion += 1
    this.present({ resultMode: false, mapLoading: false })
    if (wx.pageScrollTo) wx.pageScrollTo({scrollTop:0,duration:0})
  },

  showRoomResults() {
    if (!this.data.center) { wx.showToast({title:'至少两位成员保存出发点后才能寻找',icon:'none'}); return }
    this.adjustingPlaces = false
    this.present({resultMode:true})
    this.fitMap()
    if (!this.data.decisionCandidates.length) this.searchRoomCandidates()
  },

  setFilter(event) {
    const filter = event.currentTarget.dataset.filter
    if (['all','drink','food','mall'].includes(filter)) this.present({filter})
  },

  mapAction(event) {
    const action = event.currentTarget.dataset.action
    if (action === 'fit') { this.fitMap(); return }
    this.present({mapScale: Math.max(3, Math.min(20, this.data.mapScale + (action === 'in' ? 1 : -1)))})
  },

  fitMap() {
    if (!this.data.center || typeof wx.createMapContext !== 'function') return
    this.mapContext = this.mapContext || wx.createMapContext('midpointMap', this)
    if (this.mapContext && this.mapContext.includePoints) this.mapContext.includePoints({points:(this.data.markers || []).map(marker => ({latitude:marker.latitude,longitude:marker.longitude})),padding:[44,64,64,44]})
  },

  coverError(event) {
    const id = String(event.currentTarget.dataset.id)
    const poi = this.findCandidate(id)
    if (!poi) return
    this.failedCovers = this.failedCovers || new Set()
    this.failedCovers.add(candidateDetailKey(poi))
    const swipeCurrent = this.data.swipeCurrent && String(this.data.swipeCurrent.id) === id ? Object.assign({},this.data.swipeCurrent,{cover:presentationPoi(poi).fallbackCover}) : this.data.swipeCurrent
    this.present({swipeCurrent})
  },

  async togglePoi(event) {
    const id = String(event.currentTarget.dataset.id)
    const expandedPoiId = String(this.data.expandedPoiId) === id ? '' : id
    this.present({expandedPoiId})
    if (expandedPoiId) await this.loadPoiDetails(id)
  },

  findCandidate(id) {
    return this.activeSwipeCandidates().find(poi => String(poi.id) === String(id))
  },

  async loadPoiDetails(id, force) {
    const poi = this.findCandidate(id)
    if (!poi) return
    this.poiDetails = this.poiDetails || Object.create(null)
    const key = candidateDetailKey(poi), current = this.poiDetails[key]
    if (!force && current && (current.loading || current.loaded)) return
    const generation = this.detailGeneration || 0, scope = this.localScope
    const context = this.captureViewContext()
    this.poiDetails[key] = {loading:true,categories:[]}
    this.present({})
    try {
      const results = await Promise.all([amap.detail(poi),amap.categories(poi)])
      if (!this.viewContextMatches(context) || scope !== this.localScope || !this.localScopeMatches() || generation !== (this.detailGeneration || 0) || !this.findCandidate(id)) return
      const info = results[0] || {}
      const categories = (results[1] || []).map(category => Object.assign({}, category, {expanded:false,loading:false,error:'',pois:(category.pois || []).map(row => presentationPoi(Object.assign({},row,{dist:distanceMeters({latitude:poi.lat,longitude:poi.lng},row)})))}))
      this.poiDetails[key] = {loaded:true,loading:false,info,categories}
    } catch(error) {
      if (scope !== this.localScope || !this.localScopeMatches() || generation !== (this.detailGeneration || 0)) return
      this.poiDetails[key] = {loading:false,error:error.message || '地点详情加载失败，请重试',categories:[]}
    }
    this.present({swipeDetail:this.data.swipeCurrent && candidateDetailKey(this.data.swipeCurrent) === key ? this.poiDetails[key] : this.data.swipeDetail})
  },

  retryPoi(event) { return this.loadPoiDetails(String(event.currentTarget.dataset.id),true) },

  toggleCategory(event) {
    const data = event.currentTarget.dataset, poi = this.findCandidate(data.id)
    if (!poi) return
    const details = this.poiDetails[candidateDetailKey(poi)]
    const category = details && details.categories.find(item => item.key === data.key)
    if (!category) return
    category.expanded = !category.expanded
    this.present({})
  },

  async moreCategory(event) {
    const context = this.captureViewContext()
    const data = event.currentTarget.dataset, poi = this.findCandidate(data.id)
    if (!poi) return
    const details = this.poiDetails[candidateDetailKey(poi)]
    const category = details && details.categories.find(item => item.key === data.key)
    if (!category || category.loading || Number(category.page) >= 4 || category.pois.length >= Number(category.total)) return
    category.loading = true; category.error = ''; this.present({})
    try {
      const result = await amap.categoryPage(poi, category.key, Number(category.page || 1) + 1)
      if (!this.viewContextMatches(context) || this.poiDetails[candidateDetailKey(poi)] !== details) return
      const seen = new Set(category.pois.map(candidateDetailKey))
      ;(result.pois || []).forEach(row => {const key = candidateDetailKey(row); if (!seen.has(key)){seen.add(key);category.pois.push(presentationPoi(Object.assign({},row,{dist:distanceMeters({latitude:poi.lat,longitude:poi.lng},row)})))}})
      category.page = Number(result.page || Number(category.page || 1) + 1)
      category.capped = Boolean(result.capped)
    } catch(error){ if (!this.viewContextMatches(context)) return; category.error = error.message || '加载失败，请重试' }
    category.loading = false; this.present({})
  },

  showSwipeDetails(event) {
    const id = String(event.currentTarget.dataset.id)
    this.present({screen:'main',resultMode:true,expandedPoiId:id})
    this.loadPoiDetails(id)
  },

  retryMapSearch() {
    if (this.data.room) return this.searchRoomCandidates()
    if (this.data.center) return this.searchLocalCandidates(this.data.center, ++this.localSearchVersion)
  },

  captureViewContext() { return {scope:this.localScope,docId:this.docId || '',generation:this.pageGeneration || 0} },
  viewContextMatches(context) { return !this.closed && context.scope === this.localScope && this.localScopeMatches() && context.docId === (this.docId || '') && context.generation === (this.pageGeneration || 0) },
  captureRoomContext() { return Object.assign(this.captureViewContext(),{epoch:this.viewer && this.viewer.membershipEpoch || ''}) },
  roomContextMatches(context) { return this.viewContextMatches(context) && context.epoch === (this.viewer && this.viewer.membershipEpoch || '') },

  localScopeMatches() {
    return typeof storage.localScopeToken !== 'function' || this.localScope === storage.localScopeToken()
  },

  reloadLocalScope() {
    this.closeLocalPointEditor()
    this.pageGeneration = (this.pageGeneration || 0) + 1
    this.decisionToken = (this.decisionToken || 0) + 1
    this.pointFlushToken = (this.pointFlushToken || 0) + 1
    this.roomSearchToken = (this.roomSearchToken || 0) + 1
    this.pointFlushBusy = false; this.roomSearchBusy = false
    this.stopPolling()
    this.localScope = storage.localScopeToken()
    this.localSearchVersion = (this.localSearchVersion || 0) + 1
    this.detailGeneration = (this.detailGeneration || 0) + 1
    this.addressSearchRequest = (this.addressSearchRequest || 0) + 1
    this.docId = ''; this.viewer = null; this.serverRoom = null; this.pendingMeetupMutation = null
    this.poiDetails = Object.create(null); this.candidateDetails = Object.create(null); this.mineDraftDirty = false
    const app = typeof getApp === 'function' ? getApp() : null
    this.accountProfile = app && app.globalData && app.globalData.accountProfile || null
    this.scopeReady = Boolean(storage.isAccountScoped && storage.isAccountScoped())
    const local = validLocalState(storage.getLocal(LOCAL_MIDPOINT_KEY,null),this.accountProfile)
    this.localStorageReady = true
    this.present({room:null,people:[],center:null,markers:[],resultMode:false,localPoints:local.points,localCandidates:local.candidates,decisionCandidates:[],screen:'main',swipeCurrent:null,swipeDeck:[],swipeLikes:[],swipeVoteBusy:false,busy:false,pointSyncBusy:false,mapLoading:false,mapError:'',expandedPoiId:'',mineName:'',mineAddress:'',mineLocation:null,mineHasSavedLocation:false,pointSyncPending:false,pointSyncText:'',name:storage.getName(),code:''})
  },

  async onLoad(options) {
    this.entryBlocked = false
    const entryApp = typeof getApp === 'function' ? getApp() : null
    if (!entryApp || typeof entryApp.hasAccountConsent !== 'function' || !entryApp.hasAccountConsent() || !storage.isAccountScoped()) {
      this.entryBlocked = true
      const query = Object.keys(options || {}).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(options[key])}`).join('&')
      const destination = `/pages/midpoint/index${query ? `?${query}` : ''}`
      wx.switchTab({
        url: '/pages/home/index',
        success: () => {
          const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
          const home = pages.find((page) => page && typeof page.requestWechatLogin === 'function')
          if (home) home.requestWechatLogin(() => wx.navigateTo({ url: destination }), '公平碰面')
        }
      })
      return
    }
    this.closed = false
    const generation = this.pageGeneration || 0
    this.docId = (options && options.docId) || ''
    this.viewer = null
    this.mineDraftDirty = false
    this.addressSearchRequest = 0
    this.localSearchVersion = 0
    this.localStorageReady = false
    this.scopeReady = false
    this.candidateDetails = Object.create(null)
    this.serverRoom = null
    this.pendingMeetupMutation = null
    this.pointFlushBusy = false
    this.lastMeetupMutationAt = 0
    let accountProfile = null
    let localState = validLocalState(null, accountProfile)
    let localStorageMessage = ''
    const app = typeof getApp === 'function' ? getApp() : null
    const consentGranted = Boolean(app && typeof app.hasAccountConsent === 'function' && app.hasAccountConsent())
    if (!consentGranted) {
      localStorageMessage = '出发点草稿仅保存在本机；地点搜索经云端高德查询，不会自动加入共享房间。'
    } else {
      try {
        if (!app || typeof app.ensureAccountScope !== 'function') throw new Error('账户存储初始化不可用')
        accountProfile = await app.ensureAccountScope()
        if (this.closed || generation !== (this.pageGeneration || 0)) return
        this.accountProfile = accountProfile
        if (typeof storage.isAccountScoped === 'function' && !storage.isAccountScoped()) throw new Error('当前账户存储不可用')
        if (typeof storage.getScoped !== 'function' || typeof storage.setScoped !== 'function') throw new Error('账户存储版本不支持')
        const pendingCreateRaw = storage.getScoped(PENDING_CREATE_KEY, null)
        const pendingCreate = validPendingCreate(pendingCreateRaw)
        if (pendingCreateRaw && !pendingCreate && typeof storage.removeScoped === 'function') storage.removeScoped(PENDING_CREATE_KEY)
        this.pendingCreateId = pendingCreate && pendingCreate.requestId || ''
        if (this.docId) this.loadPointOutbox(this.docId)
        this.scopeReady = true
      } catch (error) {
        localStorageMessage = '本机草稿未加载：账户存储尚未准备好。'
        wx.showToast({ title: localStorageMessage, icon: 'none' })
      }
    }
    try {
      if (typeof storage.getLocal !== 'function' || typeof storage.setLocal !== 'function') throw new Error('本机存储版本尚未就绪')
      this.localScope = storage.localScopeToken()
      localState = validLocalState(storage.getLocal(LOCAL_MIDPOINT_KEY, null), accountProfile)
      this.localStorageReady = true
    } catch(error) { localStorageMessage = '本机草稿无法读取，请勿在未备份时关闭页面'; wx.showToast({title:localStorageMessage,icon:'none'}) }
    this.present({
      name: String(accountProfile && accountProfile.nickname || storage.getName() || '微信用户'),
      accountAvatar: String(accountProfile && accountProfile.avatarFileId || ''),
      headerTopPx: layout.headerTopPx(),
      amapConfigured: Boolean(amap.configuredKey()),
      localStorageMessage,
      localPoints: localState.points,
      localCandidates: localState.candidates
    })
    if (wx.onNetworkStatusChange) {
      this.networkStatusHandler = (status) => {
        if (status && status.isConnected) this.flushPendingMeetupMutation(false, true)
      }
      wx.onNetworkStatusChange(this.networkStatusHandler)
    }
    if (this.docId && this.scopeReady) this.startPolling()
  },

  refreshAccountIdentity() {
    if (!this.localScopeMatches()) return
    const app = typeof getApp === 'function' ? getApp() : null
    this.accountProfile = app && app.globalData && app.globalData.accountProfile || this.accountProfile || null
    const name = String(this.accountProfile && this.accountProfile.nickname || storage.getName() || '微信用户').trim() || '微信用户'
    this.present({ name, mineName: name, accountAvatar: String(this.accountProfile && this.accountProfile.avatarFileId || ''), localPoints: normalizeLocalPoints(this.data.localPoints, this.accountProfile) })
    if (this.data.room && this.viewer) this.renderRoom(this.data.room, this.viewer)
  },

  onShow() {
    if (this.entryBlocked) return
    const app = typeof getApp === 'function' ? getApp() : null
    if (!app || !app.hasAccountConsent || !app.hasAccountConsent() || !storage.isAccountScoped()) {
      this.stopPolling()
      this.pageGeneration = (this.pageGeneration || 0) + 1
      this.localSearchVersion = (this.localSearchVersion || 0) + 1
      this.scopeReady = false
      this.localStorageReady = false
      this.accountProfile = null
      this.viewer = null
      this.docId = ''
      this.entryBlocked = true
      this.present({ room: null, people: [], localPoints: [], localCandidates: [], name: '', mineName: '', accountAvatar: '', markers: [], center: null, resultMode: false })
      wx.switchTab({ url: '/pages/home/index' })
      return
    }
    if (this.localScope !== undefined && typeof storage.localScopeToken === 'function' && !this.localScopeMatches()) this.reloadLocalScope()
    this.refreshAccountIdentity()
    if (this.docId && this.scopeReady) {
      this.startPolling()
      this.flushPendingMeetupMutation(false, true)
    }
  },

  onHide() {
    if (this.entryBlocked) return
    this.invalidateLocalAddressSearch()
    this.present({ localAddressSuggestions: [], localAddressSearchLoading: false })
    this.stopPolling()
  },

  onUnload() {
    this.closed = true
    if (this.entryBlocked) return
    this.invalidateLocalAddressSearch()
    this.pageGeneration = (this.pageGeneration || 0) + 1
    this.stopPolling()
    this.detailGeneration = (this.detailGeneration || 0) + 1
    if (this.addressSearchTimer) clearTimeout(this.addressSearchTimer)
    if (this.networkStatusHandler && wx.offNetworkStatusChange) wx.offNetworkStatusChange(this.networkStatusHandler)
  },

  onShareAppMessage() {
    const room = this.data.room
    if (!room) return { title: '拼途 · 一起找公平碰面点', path: '/pages/home/index' }
    return {
      title: invite.shareTitle('midpoint'),
      path: invite.sharePath(room.code, 'midpoint')
    }
  },

  startPolling() {
    this.stopPolling()
    this.fetchRoom()
    this.timer = setInterval(() => this.fetchRoom(), 2000)
  },

  stopPolling() {
    this.fetchRequestToken = (this.fetchRequestToken || 0) + 1
    this.fetchBusy = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  },

  loadPointOutbox(docId) {
    if (!docId || typeof storage.getScoped !== 'function') return null
    const key = pointOutboxKey(docId)
    const pending = validPendingMeetupMutation(storage.getScoped(key, null), docId)
    if (!pending) {
      if (typeof storage.removeScoped === 'function') storage.removeScoped(key)
      return null
    }
    this.pendingMeetupMutation = pending
    this.lastMeetupMutationAt = Math.max(this.lastMeetupMutationAt || 0, pending.mutationAt)
    this.present({ pointSyncPending: true, pointSyncText: '出发点等待同步' })
    return pending
  },

  savePointOutbox(pending) {
    if (!this.scopeReady || typeof storage.setScoped !== 'function') return false
    if (!storage.setScoped(pointOutboxKey(pending.docId), pending)) return false
    this.pendingMeetupMutation = pending
    this.lastMeetupMutationAt = Math.max(this.lastMeetupMutationAt || 0, pending.mutationAt)
    return true
  },

  clearPointOutbox(docId) {
    const targetDocId = String(docId || this.docId || '')
    if (targetDocId && typeof storage.removeScoped === 'function') storage.removeScoped(pointOutboxKey(targetDocId))
    if (!this.pendingMeetupMutation || this.pendingMeetupMutation.docId === targetDocId) {
      this.pendingMeetupMutation = null
      this.present({ pointSyncPending: false, pointSyncBusy: false, pointSyncText: '' })
    }
  },

  recoverPendingPointDraft(pending, text) {
    const person = pending && pending.person
    this.clearPointOutbox(pending && pending.docId)
    if (person) {
      this.mineDraftDirty = true
      const lat = Number(person.lat)
      const lng = Number(person.lng)
      this.present({
        mineName: String(person.name || this.data.mineName || '').slice(0, 24),
        mineAddress: String(person.address || '').slice(0, 120),
        mineLocation: Number.isFinite(lat) && Number.isFinite(lng)
          ? { lat, lng, address: String(person.address || '').slice(0, 120) }
          : null,
        pointSyncPending: false,
        pointSyncText: text || '原地点已保留，请确认后重新保存'
      })
      return
    }
    this.present({ pointSyncPending: false, pointSyncText: text || '原操作已取消' })
  },

  optimisticRoom(room, viewer) {
    const pending = this.pendingMeetupMutation
    if (!room || !viewer || !pending || pending.docId !== this.docId || pending.membershipEpoch !== viewer.membershipEpoch) return room
    const meetup = room.meetup || { people: [] }
    const people = (meetup.people || []).filter((person) => person && person.uid !== viewer.uid)
    if (pending.person) people.push(Object.assign({ uid: viewer.uid, updatedAt: pending.mutationAt }, pending.person))
    return Object.assign({}, room, { meetup: Object.assign({}, meetup, { people }) })
  },

  nextMeetupMutationAt() {
    const mine = ((this.serverRoom && this.serverRoom.meetup && this.serverRoom.meetup.people) || [])
      .find((person) => this.viewer && person && person.uid === this.viewer.uid)
    const next = Math.max(Date.now(), (this.lastMeetupMutationAt || 0) + 1, (Number(mine && mine.updatedAt) || 0) + 1)
    this.lastMeetupMutationAt = next
    return next
  },

  enqueueMeetupMutation(person) {
    const viewer = this.viewer
    if (!viewer || !viewer.uid || !viewer.membershipEpoch || !this.docId) return false
    const pending = validPendingMeetupMutation({
      docId: this.docId,
      membershipEpoch: viewer.membershipEpoch,
      mutationAt: this.nextMeetupMutationAt(),
      person
    }, this.docId)
    if (!pending || !this.savePointOutbox(pending)) {
      wx.showToast({ title: '无法保存待同步出发点，请返回首页重试', icon: 'none' })
      return false
    }
    this.mineDraftDirty = false
    this.present({
      pointSyncPending: true,
      pointSyncText: '已保存到本机，正在同步…',
      syncText: '出发点待同步'
    })
    this.renderRoom(this.optimisticRoom(this.serverRoom || this.data.room, viewer), viewer)
    return true
  },

  async flushPendingMeetupMutation(notifyFailure, force) {
    const context = this.captureRoomContext()
    const pending = this.pendingMeetupMutation
    const viewer = this.viewer
    if (!pending || this.pointFlushBusy || !this.scopeReady || !this.docId || !viewer) return false
    if (pending.docId !== this.docId || pending.membershipEpoch !== viewer.membershipEpoch) {
      this.recoverPendingPointDraft(pending, '成员身份已更新，原地点已保留，请确认后重新保存')
      return false
    }
    const now = Date.now()
    if (!force && now - (this.lastPointRetryAt || 0) < 1500) return false
    this.lastPointRetryAt = now
    this.pointFlushBusy = true
    const token = this.pointFlushToken = (this.pointFlushToken || 0) + 1
    this.present({ pointSyncBusy: true, pointSyncPending: true, pointSyncText: '正在同步出发点…' })
    try {
      await gateway.setMeetupPoint({
        docId: pending.docId,
        membershipEpoch: pending.membershipEpoch,
        roundId: currentDecision(this.data.room).roundId,
        mutationAt: pending.mutationAt,
        person: pending.person
      })
      if (!this.roomContextMatches(context)) return false
      if (this.pendingMeetupMutation && this.pendingMeetupMutation.mutationAt === pending.mutationAt && this.pendingMeetupMutation.membershipEpoch === pending.membershipEpoch) {
        this.clearPointOutbox(pending.docId)
        this.present({ syncText: '已同步' })
      }
      await this.fetchRoom()
      return this.roomContextMatches(context)
    } catch (error) {
      if (!this.roomContextMatches(context)) return false
      if (error.code === 'STALE_MEMBERSHIP' || error.code === 'ROOM_NOT_FOUND') {
        this.recoverPendingPointDraft(
          pending,
          error.code === 'STALE_MEMBERSHIP'
            ? '成员身份已更新，原地点已保留，请确认后重新保存'
            : '房间已结束，原地点仍保留在输入框中'
        )
        await this.fetchRoom()
      } else if (['INVALID_POINT', 'DUPLICATE_NAME', 'CONTENT_REJECTED', 'ROOM_HISTORY_FULL'].includes(error.code)) {
        this.recoverPendingPointDraft(pending, error.message || '出发点未通过校验，请修改后重试')
        this.renderRoom(this.serverRoom || this.data.room, viewer)
        if (notifyFailure) wx.showToast({ title: error.message || '请修改出发点后重试', icon: 'none' })
      } else {
        this.present({ pointSyncPending: true, pointSyncText: '网络恢复后会自动同步', syncText: '出发点待同步' })
        if (notifyFailure) wx.showToast({ title: '已保存到本机，网络恢复后自动同步', icon: 'none' })
      }
      return false
    } finally {
      if (token === this.pointFlushToken) this.pointFlushBusy = false
      if (token === this.pointFlushToken && this.viewContextMatches(context)) {
        this.present({ pointSyncBusy: false })
        if (this.pendingMeetupMutation && this.pendingMeetupMutation.mutationAt !== pending.mutationAt) setTimeout(() => this.flushPendingMeetupMutation(false,true),0)
      }
    }
  },

  nameInput(event) {
    this.present({ name: event.detail.value })
  },

  codeInput(event) {
    this.present({ code: cleanCode(event.detail.value) })
  },

  ensurePendingCreateId(name) {
    if (this.pendingCreateId) return this.pendingCreateId
    const record = { requestId: requestId(), name: String(name || '').slice(0, 24) }
    if (typeof storage.setScoped !== 'function' || !storage.setScoped(PENDING_CREATE_KEY, record)) return ''
    this.pendingCreateId = record.requestId
    return this.pendingCreateId
  },

  clearPendingCreateId(requestKey) {
    if (requestKey && this.pendingCreateId && requestKey !== this.pendingCreateId) return
    if (typeof storage.removeScoped === 'function') storage.removeScoped(PENDING_CREATE_KEY)
    this.pendingCreateId = ''
  },

  goBack() {
    if (this.data.screen === 'swipe') {
      this.backFromSwipe()
      return
    }
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
  },

  async create() {
    if (this.data.busy || !this.localScopeMatches()) return
    const scope = this.localScope
    if (!this.scopeReady) {
      wx.showToast({ title: '创建房间前请返回首页登录', icon: 'none' })
      return
    }
    this.refreshAccountIdentity()
    const name = this.data.name.trim()
    if (!name) {
      wx.showToast({ title: '先填写名字', icon: 'none' })
      return
    }
    const pendingCreateId = this.ensurePendingCreateId(name)
    if (!pendingCreateId) {
      wx.showToast({ title: '无法保存创建请求，请返回首页重试', icon: 'none' })
      return
    }
    this.closeLocalPointEditor()
    this.present({ busy: true })
    try {
      const result = await gateway.create(roomInput(name), pendingCreateId)
      if (scope !== this.localScope || !this.localScopeMatches()) return
      this.clearPendingCreateId(pendingCreateId)
      storage.saveName(name)
      this.pendingMeetupMutation = null
      this.pointFlushToken = (this.pointFlushToken || 0) + 1; this.pointFlushBusy = false
      this.roomSearchToken = (this.roomSearchToken || 0) + 1; this.roomSearchBusy = false
      this.detailGeneration = (this.detailGeneration || 0) + 1; this.poiDetails = Object.create(null)
      this.docId = result.docId
      this.loadPointOutbox(this.docId)
      storage.save({ docId: result.docId, room: result.room })
      this.applyRoom(result.room, result.viewer)
      this.startPolling()
    } catch (error) {
      if (scope !== this.localScope || !this.localScopeMatches()) return
      wx.showToast({ title: error.message || '创建失败，请重试', icon: 'none' })
    } finally {
      if (scope === this.localScope && this.localScopeMatches()) this.present({ busy: false })
    }
  },

  async join() {
    if (this.data.busy || !this.localScopeMatches()) return
    const scope = this.localScope
    if (!this.scopeReady) {
      wx.showToast({ title: '加入房间前请返回首页登录', icon: 'none' })
      return
    }
    this.refreshAccountIdentity()
    const name = this.data.name.trim()
    const code = cleanCode(this.data.code)
    if (!name || code.length !== 8) {
      wx.showToast({ title: '请填写 8 位房间码', icon: 'none' })
      return
    }
    this.closeLocalPointEditor()
    this.present({ busy: true })
    try {
      const result = await gateway.join(code, 'midpoint', name)
      if (scope !== this.localScope || !this.localScopeMatches()) return
      storage.saveName(name)
      this.docId = result.docId
      this.loadPointOutbox(this.docId)
      storage.save({ docId: result.docId, room: result.room })
      this.applyRoom(result.room, result.viewer)
      this.startPolling()
    } catch (error) {
      if (scope !== this.localScope || !this.localScopeMatches()) return
      wx.showToast({ title: error.message || '加入失败，请重试', icon: 'none' })
    } finally {
      if (scope === this.localScope && this.localScopeMatches()) this.present({ busy: false })
    }
  },

  async fetchRoom() {
    if (!this.scopeReady || !this.docId || this.fetchBusy) return
    this.fetchBusy = true
    const context = this.captureViewContext()
    const token = this.fetchRequestToken = (this.fetchRequestToken || 0) + 1
    try {
      const requestedId = this.docId, scope = this.localScope
      const result = await gateway.getRoom(requestedId)
      if (token !== this.fetchRequestToken || !this.viewContextMatches(context)) return
      this.lastFetchError = false
      if (!result.room) {
        const removedId = this.docId
        const pending = this.pendingMeetupMutation
        if (pending && pending.docId === removedId) {
          this.recoverPendingPointDraft(pending, '房间已结束，原地点仍保留在输入框中')
        } else {
          this.clearPointOutbox(removedId)
        }
        this.docId = ''
        this.serverRoom = null
        this.stopPolling()
        storage.remove(removedId)
        this.present({ room: null, people: [], center: null, resultMode: false, mineEditorOpen: false, screen: 'main', syncText: '房间已结束' })
        wx.showToast({ title: pending ? '房间已结束，原地点已保留' : '房间已解散或你已退出', icon: 'none' })
        return
      }
      storage.save({ docId: this.docId, room: result.room })
      this.applyRoom(result.room, result.viewer)
      this.present({ syncText: this.pendingMeetupMutation ? '出发点待同步' : '已同步' })
    } catch (error) {
      if (token !== this.fetchRequestToken || !this.viewContextMatches(context)) return
      this.present({ syncText: '同步重试中' })
      if (!this.lastFetchError) {
        wx.showToast({ title: error.message || '同步暂时中断', icon: 'none' })
      }
      this.lastFetchError = true
    } finally {
      if (token === this.fetchRequestToken) this.fetchBusy = false
      if (this.viewContextMatches(context) && this.pendingMeetupMutation) setTimeout(() => this.flushPendingMeetupMutation(false, false), 0)
    }
  },

  applyRoom(room, viewer) {
    this.serverRoom = room
    this.viewer = viewer || null
    const pending = this.pendingMeetupMutation
    if (pending && viewer && pending.membershipEpoch !== viewer.membershipEpoch) {
      this.recoverPendingPointDraft(pending, '成员身份已更新，原地点已保留，请确认后重新保存')
    }
    const mine = ((room && room.meetup && room.meetup.people) || []).find((person) => viewer && person && person.uid === viewer.uid)
    this.lastMeetupMutationAt = Math.max(this.lastMeetupMutationAt || 0, Number(mine && mine.updatedAt) || 0)
    this.renderRoom(this.optimisticRoom(room, viewer), viewer)
  },

  renderRoom(room, viewer) {
    if (this.data.localPointEditorId) this.closeLocalPointEditor()
    const decision = currentDecision(room)
    const candidates = decisionCandidates(decision, viewer, room, this.candidateDetails)
    const participation = decisionParticipation(decision, room)
    const locationPeople = (room.meetup && room.meetup.people) || []
    const byUid = new Map(locationPeople.map((person) => [String(person && person.uid || ''), person]))
    ;(room.members || []).filter((member) => member && member.uid).forEach((member) => {
      const uid = String(member.uid)
      if (!byUid.has(uid)) byUid.set(uid, { uid, name: member.name || '成员', address: '' })
    })
    if (viewer && viewer.uid && !byUid.has(String(viewer.uid))) {
      byUid.set(String(viewer.uid), { uid: String(viewer.uid), name: this.accountProfile && this.accountProfile.nickname || viewer.name || '我', address: '' })
    }
    const people = Array.from(byUid.values()).map((person) => Object.assign({}, person, {
      isSelf: Boolean(viewer && person && person.uid === viewer.uid),
      name: viewer && person && person.uid === viewer.uid && this.accountProfile && this.accountProfile.nickname ? this.accountProfile.nickname : (person.name || '成员'),
      ownAvatar: Boolean(viewer && person && person.uid === viewer.uid && this.accountProfile && this.accountProfile.avatarFileId) ? this.accountProfile.avatarFileId : ''
    }))
    const mine = people.find((person) => viewer && person && person.uid === viewer.uid) || null
    const mineHasLocation = Boolean(mine && Number.isFinite(mine.lat) && Number.isFinite(mine.lng))
    const next = {
      room,
      people,
      center: midpoint.average(room),
      markers: midpoint.markers(room),
      resultMode: Boolean(midpoint.average(room)) && !this.adjustingPlaces,
      decision,
      decisionCandidates: candidates,
      decisionConfirmed: decision.state === 'confirmed',
      decisionParticipantCount: participation.voters,
      decisionMemberCount: participation.members,
      confirmedCandidate: candidates.find((candidate) => candidate.id === decision.confirmedCandidateId) || null,
      isOwner: Boolean(this.viewer && this.viewer.isOwner)
    }
    if (!this.mineDraftDirty) {
      next.mineName = (this.accountProfile && this.accountProfile.nickname) || (mine && mine.name) || (viewer && viewer.name) || '微信用户'
      next.mineAddress = (mine && mine.address) || ''
      next.mineLocation = mineHasLocation ? { lat: mine.lat, lng: mine.lng, address: mine.address } : null
      next.mineHasSavedLocation = mineHasLocation
      next.addressSuggestions = []
      next.addressSuggestionsVisible = false
    }
    this.present(next, () => this.maybeAutoSearchRoomCandidates())
  },

  maybeAutoSearchRoomCandidates() {
    const decision = currentDecision(this.data.room)
    const viewer = this.viewer
    if (!viewer || !viewer.isOwner || this.data.busy || this.roomSearchBusy || this.pendingMeetupMutation || !this.data.center || decision.state === 'confirmed' || decision.candidates.length || !amap.configuredKey()) return
    const center = this.data.center
    const centerKey = `${Number(center.latitude).toFixed(6)},${Number(center.longitude).toFixed(6)}`
    const key = `${this.docId}:${decision.roundId || 'initial'}:${centerKey}`
    this.autoSearchedRoomRounds = this.autoSearchedRoomRounds || new Set()
    if (this.autoSearchedRoomRounds.has(key)) return
    this.autoSearchedRoomRounds.add(key)
    this.searchRoomCandidates()
  },

  rememberCandidateDetails(candidates) {
    const items = candidates || []
    items.forEach((candidate) => {
      const key = candidateDetailKey(candidate)
      if (!key) return
      this.candidateDetails[key] = {
        address: String(candidate.address || '').slice(0, 120),
        category: String(candidate.category || '').slice(0, 120),
        phone: String(candidate.phone || '').slice(0, 80),
        rating: String(candidate.rating || '').slice(0, 16),
        averageCost: String(candidate.averageCost || '').slice(0, 16),
        photos: Array.isArray(candidate.photos) ? candidate.photos.slice(0,3) : [],
        poiId: String(candidate.poiId || '').slice(0,80)
      }
    })
  },

  async requestLocation(onSuccess) {
    if (this.data.busy || !this.localScopeMatches()) return
    const scope = this.localScope
    const context = this.captureRoomContext()
    if (typeof wx.chooseLocation !== 'function') {
      wx.showToast({ title: '当前微信版本不支持地图选点，请更新微信后重试', icon: 'none' })
      return
    }
    try {
      await requirePrivacyAuthorization()
    } catch (_) {
      if (!this.roomContextMatches(context)) return
      wx.showModal({
        title: '需要隐私授权',
        content: '选择地图地点前，请先阅读并同意小程序隐私保护指引。',
        confirmText: '查看指引',
        success: (result) => {
          if (result.confirm && wx.openPrivacyContract) wx.openPrivacyContract()
        }
      })
      return
    }
    if (!this.roomContextMatches(context)) return
    wx.chooseLocation({
      success: (value) => { if (this.roomContextMatches(context)) onSuccess(value) },
      fail: (error) => { if (this.roomContextMatches(context)) this.handleLocationFailure(error) }
    })
  },

  handleLocationFailure(error) {
    const detail = String(error.errMsg || '')
    if (detail.includes('cancel')) return
    if (/privacy|103|104/i.test(detail)) {
      wx.showToast({ title: '请先同意隐私保护指引', icon: 'none' })
      return
    }
    if (/not declared|requiredPrivateInfos|api scope/i.test(detail)) {
      wx.showToast({ title: '位置服务尚未开通，请稍后再试', icon: 'none' })
      return
    }
    wx.showModal({
      title: '无法选择位置',
      content: '请在微信设置中允许位置信息权限后重试。',
      confirmText: '去设置',
      success: (result) => {
        if (result.confirm) wx.openSetting()
      }
    })
  },

  chooseLocation() {
    this.requestLocation((location) => {
      const address = String(location.address || location.name || '').slice(0, 120)
      this.mineDraftDirty = true
      this.present({
        mineAddress: address,
        mineLocation: { lat: Number(location.latitude), lng: Number(location.longitude), address },
        addressSuggestions: [],
        addressSuggestionsVisible: false
      })
    })
  },

  saveLocalState(points, candidates) {
    if (!this.localStorageReady || typeof storage.setLocal !== 'function' || !this.localScopeMatches()) return false
    // The avatar belongs to the account profile only.  Local midpoint drafts keep
    // locations, while shared rooms never receive profile/avatar fields.
    const savedPoints = (points || []).map((point) => ({
      id: point.id,
      isSelf: Boolean(point.isSelf),
      name: point.name,
      label: point.label,
      initial: point.initial,
      address: point.address,
      lat: point.lat,
      lng: point.lng
    }))
    const saved = storage.setLocal(LOCAL_MIDPOINT_KEY, { points: savedPoints, candidates })
    if (!saved) wx.showToast({title:'未保存：本机存储不可用，请勿关闭页面',icon:'none'})
    return saved
  },

  resetLocalCalculation(points) {
    const normalizedPoints = normalizeLocalPoints(points, this.accountProfile)
    this.localSearchVersion += 1
    this.detailGeneration = (this.detailGeneration || 0) + 1
    this.poiDetails = Object.create(null)
    if (!this.saveLocalState(normalizedPoints, [])) return false
    this.present({
      localPoints: normalizedPoints,
      localCandidates: [],
      localCalculated: false,
      resultMode: false,
      center: null,
      markers: [],
      mapSearchMessage: ''
    })
    return true
  },

  addLocalPoint() {
    if (this.data.localPoints.length >= MAX_LOCAL_POINTS) {
      wx.showToast({ title: '最多 6 位出发的人', icon: 'none' })
      return
    }
    this.closeLocalPointEditor()
    const index = this.data.localPoints.length
    const points = this.data.localPoints.concat({
      id: `local-friend-${Date.now()}-${index}`,
      isSelf: false,
      label: `朋友 ${localFriendLetter(index - 1)}`,
      name: '',
      initial: localFriendLetter(index - 1),
      address: '',
      lat: null,
      lng: null
    })
    this.resetLocalCalculation(points)
  },

  removeLocalPoint(event) {
    const id = String(event.currentTarget.dataset.id || '')
    const target = this.data.localPoints.find((point) => String(point.id) === id)
    if (!target || target.isSelf) return
    if (this.data.localPoints.length <= 2) { wx.showToast({title:'至少保留 2 个出发点',icon:'none'}); return }
    this.closeLocalPointEditor()
    const points = this.data.localPoints.filter((point) => String(point.id) !== id)
    this.resetLocalCalculation(points)
  },

  invalidateLocalAddressSearch() {
    this.localAddressSearchRequest = (this.localAddressSearchRequest || 0) + 1
    this.localAddressResultsContext = null
    if (this.localAddressSearchTimer) clearTimeout(this.localAddressSearchTimer)
    this.localAddressSearchTimer = null
  },

  closeLocalPointEditor() {
    this.localPointEditorVersion = (this.localPointEditorVersion || 0) + 1
    this.invalidateLocalAddressSearch()
    this.present({ localPointEditorId: '', localPointEditorLabel: '', localAddressQuery: '', localAddressSuggestions: [], localAddressSearchLoading: false, localAddressMessage: '', localAddressError: false })
  },

  openLocalPointEditor(event) {
    if (this.data.busy || this.data.room || this.docId || !this.localStorageReady || !this.localScopeMatches()) return
    const id = String(event.currentTarget.dataset.id || '')
    const point = this.data.localPoints.find((item) => String(item.id) === id)
    if (!point || this.data.localPointEditorId === id) return
    this.closeLocalPointEditor()
    this.present({ localPointEditorId: id, localPointEditorLabel: point.label, localAddressQuery: '', localAddressMessage: '输入至少 2 个字，搜索后选择具体地点；原地点会保留到选定新地点。' })
  },

  captureLocalPointEditor() {
    return Object.assign(this.captureViewContext(), { pointId: this.data.localPointEditorId, editorVersion: this.localPointEditorVersion || 0, editRevision: this.localPointEditRevision || 0 })
  },

  localPointEditorMatches(context) {
    return this.viewContextMatches(context) && !this.data.room && !this.docId && !this.data.busy &&
      context.editorVersion === (this.localPointEditorVersion || 0) && context.editRevision === (this.localPointEditRevision || 0) && context.pointId === this.data.localPointEditorId &&
      this.data.localPoints.some((point) => String(point.id) === context.pointId)
  },

  localAddressInput(event) {
    const context = this.captureLocalPointEditor()
    if (!this.localPointEditorMatches(context)) return
    const query = String(event.detail.value || '').slice(0, 80)
    this.invalidateLocalAddressSearch()
    this.localPointEditRevision = (this.localPointEditRevision || 0) + 1
    this.present({ localAddressQuery: query, localAddressSuggestions: [], localAddressSearchLoading: false, localAddressError: false, localAddressMessage: query.trim().length < 2 ? '请输入至少 2 个字的地点名称或地址。' : '' })
    if (query.trim().length < 2) return
    const inputContext = this.captureLocalPointEditor()
    const request = this.localAddressSearchRequest
    this.localAddressSearchTimer = setTimeout(() => {
      this.localAddressSearchTimer = null
      if (request === this.localAddressSearchRequest && this.localPointEditorMatches(inputContext)) this.searchLocalPointAddress()
    }, 300)
  },

  async searchLocalPointAddress() {
    const context = this.captureLocalPointEditor()
    if (!this.localPointEditorMatches(context)) return
    const query = String(this.data.localAddressQuery || '').trim()
    this.invalidateLocalAddressSearch()
    const request = this.localAddressSearchRequest
    const current = () => request === this.localAddressSearchRequest && this.localPointEditorMatches(context) && query === String(this.data.localAddressQuery || '').trim()
    if (query.length < 2) {
      this.present({ localAddressSuggestions: [], localAddressSearchLoading: false, localAddressError: false, localAddressMessage: '请输入至少 2 个字的地点名称或地址。' })
      return
    }
    this.present({ localAddressSuggestions: [], localAddressSearchLoading: true, localAddressMessage: '', localAddressError: false })
    try {
      const results = await amap.inputTips(query)
      if (!current()) return
      const suggestions = (Array.isArray(results) ? results : []).filter((item) => item && hasLocalCoordinates(item) && String(item.name || item.address || '').trim()).slice(0, 10).map((item) => ({
        id: String(item.id || item.name || '').slice(0, 80), name: String(item.name || item.address).slice(0, 80), address: String(item.address || '').slice(0, 120), lat: Number(item.lat), lng: Number(item.lng)
      }))
      this.localAddressResultsContext = Object.assign({}, context, { request, query })
      this.present({ localAddressSuggestions: suggestions, localAddressSearchLoading: false, localAddressMessage: suggestions.length ? '选择下方地点，将替换当前出发点。' : '没有找到带坐标的地点，请补充城市或更换关键词后重试。', localAddressError: false })
    } catch (error) {
      if (!current()) return
      this.present({ localAddressSuggestions: [], localAddressSearchLoading: false, localAddressMessage: error.message || '地点搜索失败，请点击搜索重试。', localAddressError: true })
    }
  },

  selectLocalAddressSuggestion(event) {
    const context = this.localAddressResultsContext
    if (!context || context.request !== this.localAddressSearchRequest || context.query !== String(this.data.localAddressQuery || '').trim() || !this.localPointEditorMatches(context)) return
    const index = Number(event.currentTarget.dataset.index)
    const suggestion = Number.isInteger(index) && this.data.localAddressSuggestions[index]
    if (!suggestion) return
    this.applyLocalPointSelection(context, suggestion)
  },

  applyLocalPointSelection(context, location) {
    if (!this.localPointEditorMatches(context)) return
    if (!hasLocalCoordinates(location)) {
      this.present({ localAddressError: true, localAddressMessage: '这个地点的坐标无效，请重新搜索或从地图选点。' })
      return
    }
    const address = ([location.name, location.address].filter(Boolean).join(' · ') || '地图地点').slice(0, 120)
    const points = this.data.localPoints.map((point) => String(point.id) === context.pointId ? Object.assign({}, point, {
      name: String(location.name || location.address || point.name).slice(0, 48), address, lat: Number(location.lat), lng: Number(location.lng)
    }) : point)
    if (!this.resetLocalCalculation(points)) {
      this.present({ localAddressError: true, localAddressMessage: '新地点未保存，本机存储不可用，请清理空间后重新选择。' })
      return
    }
    this.closeLocalPointEditor()
  },

  chooseLocalPoint(event) {
    const id = String(event.currentTarget.dataset.id || this.data.localPointEditorId || '')
    if (!id) return
    if (this.data.localPointEditorId !== id) this.openLocalPointEditor({ currentTarget: { dataset: { id } } })
    if (!this.localPointEditorMatches(this.captureLocalPointEditor())) return
    this.localPointEditRevision = (this.localPointEditRevision || 0) + 1
    const context = this.captureLocalPointEditor()
    this.invalidateLocalAddressSearch()
    this.present({ localAddressSuggestions: [], localAddressSearchLoading: false })
    this.requestLocation((location) => this.applyLocalPointSelection(context, { name: location.name, address: location.address, lat: location.latitude, lng: location.longitude }))
  },

  calculateLocalMidpoint() {
    const points = this.data.localPoints
    if (points.length < 2) {
      wx.showToast({ title: '请至少添加一位出发的朋友', icon: 'none' })
      return
    }
    if (points.some((point) => !hasLocalCoordinates(point))) {
      wx.showToast({ title: '请为每位出发的人选择地点', icon: 'none' })
      return
    }
    this.closeLocalPointEditor()
    const room = { meetup: { people: points } }
    const center = midpoint.average(room)
    this.present({
      center,
      markers: midpoint.markers(room),
      localCalculated: true,
      resultMode: true,
      mapSearchMessage: ''
    })
    this.searchLocalCandidates(center, ++this.localSearchVersion)
  },

  async searchLocalCandidates(center, searchVersion) {
    const scope = this.localScope
    if (!this.localScopeMatches()) return
    if (!amap.configuredKey()) {
      this.present({
        amapConfigured: false,
        mapSearchMessage: '未配置地图搜索；可继续用“从地图添加候选地点”手动选点。'
      })
      return
    }
    this.present({ amapConfigured: true, mapLoading:true,mapError:'',mapSearchMessage: '正在搜索中点附近的真实地点…' })
    try {
      const places = await amap.nearby(center)
      const candidates = normalizeSearchPlaces(places, center)
      if (searchVersion !== this.localSearchVersion || scope !== this.localScope || !this.localScopeMatches()) return
      this.rememberCandidateDetails(candidates)
      this.saveLocalState(this.data.localPoints, candidates)
      this.present({
        localCandidates: candidates,
        mapLoading:false,
        mapSearchMessage: candidates.length ? `已找到 ${candidates.length} 个真实地点` : '附近没有可用结果；可改用地图手动选点。'
      })
    } catch (error) {
      if (searchVersion !== this.localSearchVersion) return
      this.present({mapLoading:false,mapError:error.message || '地图查询失败', mapSearchMessage: `${error.message || '地图搜索暂时不可用'} 可改用地图手动选点。` })
    }
  },

  async searchRoomCandidates() {
    if (!this.data.room || !this.data.center || this.roomSearchBusy || this.data.busy || !this.localScopeMatches()) return
    const scope = this.localScope
    const context = this.captureRoomContext()
    if (this.pendingMeetupMutation) {
      wx.showToast({ title: '请先等待出发点同步', icon: 'none' })
      return
    }
    const decision = currentDecision(this.data.room)
    if (decision.state === 'confirmed') return
    if (!amap.configuredKey()) {
      this.present({ amapConfigured: false, mapSearchMessage: '请在微信地图中搜索并选择一个候选地点。' })
      this.addDecisionCandidate()
      return
    }
    const searchRoomId = this.docId
    const searchRoundId = decision.roundId || 'initial'
    const searchCenter = {
      latitude: Number(this.data.center.latitude),
      longitude: Number(this.data.center.longitude)
    }
    this.roomSearchBusy = true
    const token = this.roomSearchToken = (this.roomSearchToken || 0) + 1
    this.present({ amapConfigured: true, mapLoading:true,mapError:'',mapSearchMessage: '正在搜索参考中点附近的真实地点…' })
    try {
      const places = await amap.nearby(searchCenter)
      const latestCenter = this.data.center
      const latestDecision = currentDecision(this.data.room)
      const centerChanged = !latestCenter ||
        Math.abs(Number(latestCenter.latitude) - searchCenter.latitude) > 0.000001 ||
        Math.abs(Number(latestCenter.longitude) - searchCenter.longitude) > 0.000001
      if (scope !== this.localScope || !this.localScopeMatches() || this.docId !== searchRoomId || (latestDecision.roundId || 'initial') !== searchRoundId || centerChanged) return
      if (!this.roomContextMatches(context)) return
      const candidates = normalizeSearchPlaces(places, searchCenter)
      if (!candidates.length) {
        this.present({mapLoading:false, mapSearchMessage: '附近没有可用结果；可改用地图手动选点。' })
        return
      }
      this.rememberCandidateDetails(candidates)
      const saved = await this.runDecisionMutation(
        'publishDecisionCandidates',
        { candidates },
        '发布附近候选地点失败'
      )
      if (!this.roomContextMatches(context)) return
      if (saved) this.present({ mapSearchMessage: `已发布 ${candidates.length} 个真实地点，大家可以一起投票。` })
      else if (!this.data.decisionCandidates.length) this.present({mapError:'地点候选暂未发布，请重新加载或手动添加'})
    } catch (error) {
      if (!this.roomContextMatches(context)) return
      this.present({mapError:error.message || '地图查询失败', mapSearchMessage: `${error.message || '地图搜索暂时不可用'} 可改用地图手动选点。` })
    } finally {
      if (token === this.roomSearchToken) this.roomSearchBusy = false
      if (token === this.roomSearchToken && this.viewContextMatches(context)) {
        this.present({mapLoading:false})
        this.maybeAutoSearchRoomCandidates()
      }
    }
  },

  toggleMineEditor() { if (this.data.room && !this.data.busy) this.present({ mineEditorOpen: !this.data.mineEditorOpen }) },

  mineNameInput(event) {
    this.mineDraftDirty = true
    this.present({ mineName: String(event.detail.value || '').slice(0, 24) })
  },

  mineAddressInput(event) {
    const mineAddress = String(event.detail.value || '').slice(0, 120)
    this.mineDraftDirty = true
    this.present({ mineAddress, mineLocation: null, addressSuggestionsVisible: false })
    if (this.addressSearchTimer) clearTimeout(this.addressSearchTimer)
    this.addressSearchTimer = setTimeout(() => {
      this.addressSearchTimer = null
      this.searchAddressSuggestions(mineAddress)
    }, 260)
  },

  mineAddressFocus() {
    if (this.data.addressSuggestions.length) {
      this.present({ addressSuggestionsVisible: true })
      return
    }
    this.searchAddressSuggestions(this.data.mineAddress)
  },

  async searchAddressSuggestions(query) {
    const context = this.captureRoomContext()
    const value = String(query || '').trim()
    const request = ++this.addressSearchRequest
    if (value.length < 2) {
      this.present({ addressSuggestions: [], addressSuggestionsVisible: false, addressSearchLoading: false })
      return
    }
    if (!amap.configuredKey()) {
      this.present({ amapConfigured: false, addressSuggestions: [], addressSuggestionsVisible: false })
      return
    }
    this.present({ amapConfigured: true, addressSearchLoading: true })
    try {
      const suggestions = await amap.inputTips(value)
      if (!this.roomContextMatches(context) || request !== this.addressSearchRequest || value !== String(this.data.mineAddress || '').trim()) return
      this.present({
        addressSuggestions: suggestions,
        addressSuggestionsVisible: true,
        addressSearchLoading: false
      })
    } catch (error) {
      if (request !== this.addressSearchRequest) return
      this.present({ addressSuggestions: [], addressSuggestionsVisible: false, addressSearchLoading: false })
    }
  },

  selectAddressSuggestion(event) {
    const index = Number(event.currentTarget.dataset.index)
    const suggestion = this.data.addressSuggestions[index]
    if (!suggestion) return
    if (this.addressSearchTimer) clearTimeout(this.addressSearchTimer)
    this.addressSearchTimer = null
    this.mineDraftDirty = true
    this.addressSearchRequest += 1
    const selectedAddress = [suggestion.name, suggestion.address].filter(Boolean).join(' · ')
    this.present({
      mineAddress: selectedAddress,
      mineLocation: { lat: suggestion.lat, lng: suggestion.lng, address: selectedAddress },
      addressSuggestionsVisible: false
    })
  },

  async saveMeetupLocation() {
    if (!this.localScopeMatches() || this.entryBlocked) return
    this.refreshAccountIdentity()
    const viewer = this.viewer
    if (!viewer || !viewer.uid || !viewer.membershipEpoch) {
      wx.showToast({ title: '成员身份尚未同步，请稍后重试', icon: 'none' })
      return
    }
    const name = String(this.data.mineName || '').trim()
    const location = this.data.mineLocation
    if (!name) {
      wx.showToast({ title: '请填写自己的名字', icon: 'none' })
      return
    }
    if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
      wx.showToast({ title: '请从搜索结果或地图中选择具体地点', icon: 'none' })
      return
    }
    const person = {
      name,
      address: String(location.address || this.data.mineAddress || '').slice(0, 120),
      lat: location.lat,
      lng: location.lng
    }
    if (!this.enqueueMeetupMutation(person)) return
    storage.saveName(name)
    await this.flushPendingMeetupMutation(true, true)
  },

  async clearMeetupLocation() {
    const context = this.captureRoomContext()
    const viewer = this.viewer
    if (!viewer || !viewer.uid || !viewer.membershipEpoch || this.data.busy) return
    const result = await new Promise((resolve) => wx.showModal({
      title: '清除我的出发点？',
      content: '清除后不会再参与中点计算。',
      success: resolve,
      fail: () => resolve({ confirm: false })
    }))
    if (!result.confirm || !this.roomContextMatches(context)) return
    if (!this.enqueueMeetupMutation(null)) return
    await this.flushPendingMeetupMutation(true, true)
  },

  decisionMutationBase() {
    const viewer = this.viewer
    const decision = currentDecision(this.data.room)
    if (!viewer || !viewer.uid || !viewer.membershipEpoch) return null
    return {
      docId: this.docId,
      membershipEpoch: viewer.membershipEpoch,
      roundId: decision.roundId,
      revision: decision.revision
    }
  },

  async runDecisionMutation(action, extra, fallbackMessage) {
    if (!this.data.room || this.data.busy || !this.localScopeMatches()) return false
    const context = this.captureRoomContext()
    const token = this.decisionToken = (this.decisionToken || 0) + 1
    const base = this.decisionMutationBase()
    if (!base) {
      wx.showToast({ title: '成员身份尚未同步，请稍后重试', icon: 'none' })
      return false
    }
    this.present({ busy: true })
    try {
      await gateway[action](Object.assign(base, extra || {}))
      if (!this.roomContextMatches(context)) return false
      await this.fetchRoom()
      return this.roomContextMatches(context)
    } catch (error) {
      if (!this.roomContextMatches(context)) return false
      if (['STALE_MEMBERSHIP', 'STALE_DECISION', 'DECISION_CONFIRMED', 'CANDIDATE_NOT_FOUND'].includes(error.code)) {
        await this.fetchRoom()
      }
      if (!this.roomContextMatches(context)) return false
      wx.showToast({ title: error.message || fallbackMessage, icon: 'none' })
      return false
    } finally {
      if (token === this.decisionToken && this.viewContextMatches(context)) this.present({ busy: false })
    }
  },

  addDecisionCandidate() {
    const decision = currentDecision(this.data.room)
    if (decision.state === 'confirmed') {
      wx.showToast({ title: '地点已确定，请房主先重新选择', icon: 'none' })
      return
    }
    if (decision.candidates.length >= 12) {
      wx.showToast({ title: '最多添加 12 个候选地点', icon: 'none' })
      return
    }
    this.requestLocation((location) => this.publishLocationCandidate(location))
  },

  addLocalCandidate() {
    if (!this.data.center) {
      wx.showToast({ title: '先算出公平中点', icon: 'none' })
      return
    }
    if (this.data.localCandidates.length >= 12) {
      wx.showToast({ title: '最多添加 12 个候选地点', icon: 'none' })
      return
    }
    this.requestLocation((location) => {
      const base = locationCandidate(location)
      if (!Number.isFinite(base.lat) || !Number.isFinite(base.lng)) return
      if (this.data.localCandidates.some((item) => item.name === base.name && item.lat === base.lat && item.lng === base.lng)) {
        wx.showToast({ title: '这个地点已经添加过了', icon: 'none' })
        return
      }
      const candidate = Object.assign(base, {
        id: `local-candidate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        dist: distanceMeters(this.data.center, base)
      })
      this.localSearchVersion += 1
      const candidates = this.data.localCandidates.concat(candidate)
      this.saveLocalState(this.data.localPoints, candidates)
      this.present({ localCandidates: candidates })
    })
  },

  removeLocalCandidate(event) {
    const id = String(event.currentTarget.dataset.id || '')
    this.localSearchVersion += 1
    const candidates = this.data.localCandidates.filter((candidate) => String(candidate.id) !== id)
    this.saveLocalState(this.data.localPoints, candidates)
    this.present({ localCandidates: candidates })
  },

  activeSwipeCandidates() {
    return this.data.room ? this.data.decisionCandidates : this.data.localCandidates
  },

  startSwipe() {
    const deck = this.activeSwipeCandidates().map((candidate) => Object.assign({}, candidate, {
      initial: String(candidate.name || '?').slice(0, 1),
      cover: presentationPoi(candidate).cover
    }))
    if (!deck.length) {
      wx.showToast({ title: '先添加几个候选去处', icon: 'none' })
      return
    }
    this.present({
      screen: 'swipe',
      swipeDeck: deck,
      swipeIndex: 0,
      swipeCurrent: deck[0],
      swipeLikes: [],
      swipeFinished: false,
      swipeFlipped: false,
      swipeDragX: 0,
      swipeCardStyle: ''
    })
  },

  swipeAction(event) {
    return this.takeSwipeAction(event.currentTarget.dataset.action)
  },

  async takeSwipeAction(action) {
    const context = this.captureRoomContext()
    const current = this.data.swipeCurrent
    if (!current || this.data.swipeVoteBusy || !['like', 'pass'].includes(action)) return
    if (this.data.room && !this.data.decisionConfirmed) {
      this.present({ swipeVoteBusy: true })
      const saved = await this.runDecisionMutation(
        'setDecisionVote',
        { candidateId: current.id, value: action === 'like' ? 'want' : 'no' },
        '保存盲盒选择失败'
      )
      if (!this.roomContextMatches(context)) return
      this.present({ swipeVoteBusy: false })
      if (!saved) return
    }
    const likes = action === 'like' ? this.data.swipeLikes.concat(current) : this.data.swipeLikes
    const nextIndex = this.data.swipeIndex + 1
    const finished = nextIndex >= this.data.swipeDeck.length
    this.present({
      swipeLikes: likes,
      swipeIndex: nextIndex,
      swipeCurrent: finished ? null : this.data.swipeDeck[nextIndex],
      swipeFinished: finished,
      swipeFlipped: false,
      swipeDragX: 0,
      swipeCardStyle: '',
      swipeVoteBusy: false
    })
  },

  flipSwipeCard() {
    if (!this.data.swipeCurrent) return
    const flipped = !this.data.swipeFlipped
    this.present({swipeFlipped:flipped,swipeDetail:(this.poiDetails || {})[candidateDetailKey(this.data.swipeCurrent)] || null})
    if (flipped) this.loadPoiDetails(this.data.swipeCurrent.id)
  },

  swipeTouchStart(event) {
    if (this.data.swipeFlipped) {
      this.swipeStartX = null
      return
    }
    const touch = event.touches && event.touches[0]
    this.swipeStartX = touch ? Number(touch.clientX) : null
  },

  swipeTouchMove(event) {
    if (this.data.swipeFlipped) return
    const touch = event.touches && event.touches[0]
    if (!Number.isFinite(this.swipeStartX) || !touch) return
    const delta = Math.max(-180, Math.min(180, Number(touch.clientX) - this.swipeStartX))
    this.present({ swipeDragX: delta, swipeCardStyle: `transform: translateX(${delta}px) rotate(${delta / 16}deg);` })
  },

  swipeTouchEnd() {
    if (this.data.swipeFlipped) return
    const delta = Number(this.data.swipeDragX) || 0
    this.swipeStartX = null
    if (Math.abs(delta) >= 90) {
      this.takeSwipeAction(delta > 0 ? 'like' : 'pass')
      return
    }
    this.present({ swipeDragX: 0, swipeCardStyle: '' })
  },

  restartSwipe() {
    const deck = this.data.swipeDeck
    this.present({
      swipeIndex: 0,
      swipeCurrent: deck[0] || null,
      swipeLikes: [],
      swipeFinished: !deck.length,
      swipeFlipped: false,
      swipeDragX: 0,
      swipeCardStyle: ''
    })
  },

  backFromSwipe() {
    this.present({ screen: 'main', swipeCurrent: null, swipeFinished: false })
  },

  async publishLocationCandidate(location) {
    const decision = currentDecision(this.data.room)
    const candidate = locationCandidate(location)
    if (!Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng)) {
      wx.showToast({ title: '请选择一个有效地点', icon: 'none' })
      return
    }
    if (decision.candidates.some((item) => item.name === candidate.name && item.lat === candidate.lat && item.lng === candidate.lng)) {
      wx.showToast({ title: '这个候选地点已经在列表中', icon: 'none' })
      return
    }
    await this.runDecisionMutation(
      'publishDecisionCandidates',
      { candidates: decision.candidates.concat(candidate) },
      '添加候选地点失败'
    )
  },

  voteDecision(event) {
    const dataset = event.currentTarget.dataset || {}
    const value = dataset.value === 'clear' ? 'clear' : dataset.value
    if (!dataset.candidateId || !['want', 'ok', 'no', 'clear'].includes(value)) return
    this.runDecisionMutation(
      'setDecisionVote',
      { candidateId: dataset.candidateId, value },
      '保存投票失败'
    )
  },

  confirmDecision(event) {
    const candidateId = event.currentTarget.dataset.candidateId
    if (!candidateId) return
    this.runDecisionMutation(
      'confirmDecisionCandidate',
      { candidateId },
      '确定地点失败'
    )
  },

  reopenDecision() {
    this.runDecisionMutation('reopenDecision', {}, '重新选择失败')
  },

  copyCandidateName(event) {
    const value = String((event.currentTarget.dataset || {}).name || '').trim()
    if (!value) return
    wx.setClipboardData({
      data: value,
      success: () => wx.showToast({ title: '地点名称已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制地点名称失败', icon: 'none' })
    })
  },

  copyCandidateAddress(event) {
    const dataset = event.currentTarget.dataset || {}
    const value = String(dataset.address || dataset.type || '').trim()
    if (!value) {
      wx.showToast({ title: '这个地点暂无可复制地址', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: value,
      success: () => wx.showToast({ title: '地点地址已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制地点地址失败', icon: 'none' })
    })
  },

  openCandidate(event) {
    const candidate = event.currentTarget.dataset || {}
    const latitude = Number(candidate.lat)
    const longitude = Number(candidate.lng)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return
    wx.openLocation({
      latitude,
      longitude,
      name: candidate.name || '共同候选地点',
      address: candidate.address || candidate.type || '',
      scale: 16
    })
  },

  openCenter() {
    const center = this.data.center
    if (!center) return
    wx.openLocation({
      latitude: center.latitude,
      longitude: center.longitude,
      name: '参考中点',
      scale: 14
    })
  },

  copyCode() {
    if (!this.data.room) return
    wx.setClipboardData({
      data: this.data.room.code,
      fail: () => wx.showToast({ title: '复制失败，请手动记下房间码', icon: 'none' })
    })
  },

  transferOwner() { return transferOwnership(this) },

  exitRoom() {
    const context = this.captureRoomContext()
    const room = this.data.room
    if (!room || this.data.busy) return
    const action = this.data.isOwner ? 'disband' : 'leave'
    const membershipEpoch = this.viewer && this.viewer.membershipEpoch
    wx.showModal({
      title: this.data.isOwner ? '解散这个房间？' : '退出这个房间？',
      content: this.data.isOwner ? '解散后，所有成员都无法再进入。' : '退出后可凭房间码重新加入。',
      success: async (result) => {
        if (!result.confirm || !this.roomContextMatches(context)) return
        this.present({ busy: true })
        try {
          await gateway[action](this.docId, membershipEpoch)
          if (!this.roomContextMatches(context)) return
          this.clearPointOutbox(context.docId)
          storage.remove(this.docId)
          this.stopPolling()
          wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
        } catch (error) {
          if (!this.roomContextMatches(context)) return
          wx.showToast({ title: error.message || '操作失败，请重试', icon: 'none' })
        } finally {
          if (this.viewContextMatches(context)) this.present({ busy: false })
        }
      }
    })
  }
})
