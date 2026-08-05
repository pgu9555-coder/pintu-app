const gateway = require('../../services/roomGateway')
const storage = require('../../utils/storage')
const midpoint = require('../../utils/midpoint')
const layout = require('../../utils/layout')
const amap = require('../../utils/amap')
const LOCAL_MIDPOINT_KEY = 'pintu-local-midpoint-v2'
const PENDING_CREATE_KEY = 'pintu-midpoint-pending-create-v1'
const POINT_OUTBOX_PREFIX = 'pintu-midpoint-point-outbox-v1:'
const MAX_LOCAL_POINTS = 6

function emptyLocalPoints() {
  return [
    { id: 'local-1', name: '地点 1', address: '', lat: null, lng: null },
    { id: 'local-2', name: '地点 2', address: '', lat: null, lng: null }
  ]
}

function validLocalState(value) {
  const points = value && Array.isArray(value.points) ? value.points : emptyLocalPoints()
  const candidates = value && Array.isArray(value.candidates) ? value.candidates : []
  return {
    points: points.length >= 2 ? points.slice(0, MAX_LOCAL_POINTS) : emptyLocalPoints(),
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

Page({
  data: {
    name: '',
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
    mapSearchMessage: '',
    mineName: '',
    mineAddress: '',
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

  async onLoad(options) {
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
    let localState = validLocalState(null)
    let localStorageMessage = ''
    try {
      const app = typeof getApp === 'function' ? getApp() : null
      if (!app || typeof app.ensureAccountScope !== 'function') throw new Error('账户存储初始化不可用')
      await app.ensureAccountScope()
      if (typeof storage.isAccountScoped === 'function' && !storage.isAccountScoped()) throw new Error('当前账户存储不可用')
      if (typeof storage.getScoped !== 'function' || typeof storage.setScoped !== 'function') throw new Error('账户存储版本不支持')
      localState = validLocalState(storage.getScoped(LOCAL_MIDPOINT_KEY, null))
      const pendingCreateRaw = storage.getScoped(PENDING_CREATE_KEY, null)
      const pendingCreate = validPendingCreate(pendingCreateRaw)
      if (pendingCreateRaw && !pendingCreate && typeof storage.removeScoped === 'function') storage.removeScoped(PENDING_CREATE_KEY)
      this.pendingCreateId = pendingCreate && pendingCreate.requestId || ''
      if (this.docId) this.loadPointOutbox(this.docId)
      this.localStorageReady = true
      this.scopeReady = true
    } catch (error) {
      localStorageMessage = '本机草稿未加载：账户存储尚未准备好。'
      wx.showToast({ title: localStorageMessage, icon: 'none' })
    }
    this.setData({
      name: storage.getName(),
      headerTopPx: layout.headerTopPx(),
      amapConfigured: Boolean(amap.configuredKey()),
      localStorageMessage,
      localPoints: localState.points.map((point, index) => Object.assign({}, point, {
        initial: String(point.name || `地点 ${index + 1}`).slice(0, 1)
      })),
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

  onShow() {
    if (this.docId && this.scopeReady) {
      this.startPolling()
      this.flushPendingMeetupMutation(false, true)
    }
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
    if (this.addressSearchTimer) clearTimeout(this.addressSearchTimer)
    if (this.networkStatusHandler && wx.offNetworkStatusChange) wx.offNetworkStatusChange(this.networkStatusHandler)
  },

  onShareAppMessage() {
    const room = this.data.room
    if (!room) return { title: '拼途 · 一起找公平碰面点', path: '/pages/home/index' }
    return {
      title: `邀请你加入${room.name}`,
      path: `/pages/home/index?code=${room.code}`
    }
  },

  startPolling() {
    this.stopPolling()
    this.fetchRoom()
    this.timer = setInterval(() => this.fetchRoom(), 2000)
  },

  stopPolling() {
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
    this.setData({ pointSyncPending: true, pointSyncText: '出发点等待同步' })
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
      this.setData({ pointSyncPending: false, pointSyncBusy: false, pointSyncText: '' })
    }
  },

  recoverPendingPointDraft(pending, text) {
    const person = pending && pending.person
    this.clearPointOutbox(pending && pending.docId)
    if (person) {
      this.mineDraftDirty = true
      const lat = Number(person.lat)
      const lng = Number(person.lng)
      this.setData({
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
    this.setData({ pointSyncPending: false, pointSyncText: text || '原操作已取消' })
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
    this.setData({
      pointSyncPending: true,
      pointSyncText: '已保存到本机，正在同步…',
      syncText: '出发点待同步'
    })
    this.renderRoom(this.optimisticRoom(this.serverRoom || this.data.room, viewer), viewer)
    return true
  },

  async flushPendingMeetupMutation(notifyFailure, force) {
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
    this.setData({ pointSyncBusy: true, pointSyncPending: true, pointSyncText: '正在同步出发点…' })
    try {
      await gateway.setMeetupPoint({
        docId: pending.docId,
        membershipEpoch: pending.membershipEpoch,
        roundId: currentDecision(this.data.room).roundId,
        mutationAt: pending.mutationAt,
        person: pending.person
      })
      if (this.pendingMeetupMutation && this.pendingMeetupMutation.mutationAt === pending.mutationAt && this.pendingMeetupMutation.membershipEpoch === pending.membershipEpoch) {
        this.clearPointOutbox(pending.docId)
        this.setData({ syncText: '已同步' })
      }
      await this.fetchRoom()
      return true
    } catch (error) {
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
        this.setData({ pointSyncPending: true, pointSyncText: '网络恢复后会自动同步', syncText: '出发点待同步' })
        if (notifyFailure) wx.showToast({ title: '已保存到本机，网络恢复后自动同步', icon: 'none' })
      }
      return false
    } finally {
      this.pointFlushBusy = false
      this.setData({ pointSyncBusy: false })
      if (this.pendingMeetupMutation && this.pendingMeetupMutation.mutationAt !== pending.mutationAt) {
        setTimeout(() => this.flushPendingMeetupMutation(false, true), 0)
      }
    }
  },

  nameInput(event) {
    this.setData({ name: event.detail.value })
  },

  codeInput(event) {
    this.setData({ code: cleanCode(event.detail.value) })
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
    if (this.data.busy) return
    if (!this.scopeReady) {
      wx.showToast({ title: '账号身份未就绪，请返回首页重试', icon: 'none' })
      return
    }
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
    this.setData({ busy: true })
    try {
      const result = await gateway.create(roomInput(name), pendingCreateId)
      this.clearPendingCreateId(pendingCreateId)
      storage.saveName(name)
      this.docId = result.docId
      this.loadPointOutbox(this.docId)
      storage.save({ docId: result.docId, room: result.room })
      this.applyRoom(result.room, result.viewer)
      this.startPolling()
    } catch (error) {
      wx.showToast({ title: error.message || '创建失败，请重试', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  async join() {
    if (this.data.busy) return
    if (!this.scopeReady) {
      wx.showToast({ title: '账号身份未就绪，请返回首页重试', icon: 'none' })
      return
    }
    const name = this.data.name.trim()
    const code = cleanCode(this.data.code)
    if (!name || code.length !== 8) {
      wx.showToast({ title: '请填写名字和 8 位房间码', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    try {
      const result = await gateway.join(code, 'midpoint', name)
      storage.saveName(name)
      this.docId = result.docId
      this.loadPointOutbox(this.docId)
      storage.save({ docId: result.docId, room: result.room })
      this.applyRoom(result.room, result.viewer)
      this.startPolling()
    } catch (error) {
      wx.showToast({ title: error.message || '加入失败，请重试', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  async fetchRoom() {
    if (!this.scopeReady || !this.docId || this.fetchBusy) return
    this.fetchBusy = true
    try {
      const result = await gateway.getRoom(this.docId)
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
        this.setData({ room: null, syncText: '房间已结束' })
        wx.showToast({ title: pending ? '房间已结束，原地点已保留' : '房间已解散或你已退出', icon: 'none' })
        return
      }
      storage.save({ docId: this.docId, room: result.room })
      this.applyRoom(result.room, result.viewer)
      this.setData({ syncText: this.pendingMeetupMutation ? '出发点待同步' : '已同步' })
    } catch (error) {
      this.setData({ syncText: '同步重试中' })
      if (!this.lastFetchError) {
        wx.showToast({ title: error.message || '同步暂时中断', icon: 'none' })
      }
      this.lastFetchError = true
    } finally {
      this.fetchBusy = false
      if (this.pendingMeetupMutation) setTimeout(() => this.flushPendingMeetupMutation(false, false), 0)
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
    const decision = currentDecision(room)
    const candidates = decisionCandidates(decision, viewer, room, this.candidateDetails)
    const participation = decisionParticipation(decision, room)
    const people = (room.meetup && room.meetup.people) || []
    const mine = people.find((person) => viewer && person && person.uid === viewer.uid) || null
    const next = {
      room,
      people,
      center: midpoint.average(room),
      markers: midpoint.markers(room),
      decision,
      decisionCandidates: candidates,
      decisionConfirmed: decision.state === 'confirmed',
      decisionParticipantCount: participation.voters,
      decisionMemberCount: participation.members,
      confirmedCandidate: candidates.find((candidate) => candidate.id === decision.confirmedCandidateId) || null,
      isOwner: Boolean(this.viewer && this.viewer.isOwner)
    }
    if (!this.mineDraftDirty) {
      next.mineName = (mine && mine.name) || (viewer && viewer.name) || ''
      next.mineAddress = (mine && mine.address) || ''
      next.mineLocation = mine ? { lat: Number(mine.lat), lng: Number(mine.lng), address: mine.address } : null
      next.mineHasSavedLocation = Boolean(mine)
      next.addressSuggestions = []
      next.addressSuggestionsVisible = false
    }
    this.setData(next, () => this.maybeAutoSearchRoomCandidates())
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
        averageCost: String(candidate.averageCost || '').slice(0, 16)
      }
    })
  },

  async requestLocation(onSuccess) {
    if (this.data.busy) return
    if (typeof wx.chooseLocation !== 'function') {
      wx.showToast({ title: '当前微信版本不支持地图选点，请更新微信后重试', icon: 'none' })
      return
    }
    try {
      await requirePrivacyAuthorization()
    } catch (_) {
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
    wx.chooseLocation({
      success: onSuccess,
      fail: (error) => this.handleLocationFailure(error)
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
      this.setData({
        mineAddress: address,
        mineLocation: { lat: Number(location.latitude), lng: Number(location.longitude), address },
        addressSuggestions: [],
        addressSuggestionsVisible: false
      })
    })
  },

  saveLocalState(points, candidates) {
    if (!this.localStorageReady || typeof storage.setScoped !== 'function') return false
    return storage.setScoped(LOCAL_MIDPOINT_KEY, { points, candidates })
  },

  resetLocalCalculation(points) {
    this.localSearchVersion += 1
    this.saveLocalState(points, [])
    this.setData({
      localPoints: points,
      localCandidates: [],
      localCalculated: false,
      center: null,
      markers: [],
      mapSearchMessage: ''
    })
  },

  addLocalPoint() {
    if (this.data.localPoints.length >= MAX_LOCAL_POINTS) {
      wx.showToast({ title: '最多添加 6 个出发地', icon: 'none' })
      return
    }
    const index = this.data.localPoints.length + 1
    const points = this.data.localPoints.concat({
      id: `local-${Date.now()}-${index}`,
      name: `地点 ${index}`,
      initial: '地',
      address: '',
      lat: null,
      lng: null
    })
    this.resetLocalCalculation(points)
  },

  removeLocalPoint(event) {
    if (this.data.localPoints.length <= 2) {
      wx.showToast({ title: '至少保留 2 个出发地', icon: 'none' })
      return
    }
    const id = String(event.currentTarget.dataset.id || '')
    const points = this.data.localPoints.filter((point) => String(point.id) !== id)
    this.resetLocalCalculation(points)
  },

  chooseLocalPoint(event) {
    const id = String(event.currentTarget.dataset.id || '')
    if (!id) return
    this.requestLocation((location) => {
      const points = this.data.localPoints.map((point) => String(point.id) === id ? Object.assign({}, point, {
        name: String(location.name || location.address || point.name).slice(0, 48),
        initial: String(location.name || '地').slice(0, 1),
        address: String(location.address || location.name || '地图地点').slice(0, 120),
        lat: Number(location.latitude),
        lng: Number(location.longitude)
      }) : point)
      this.resetLocalCalculation(points)
    })
  },

  calculateLocalMidpoint() {
    const valid = this.data.localPoints.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    if (valid.length < 2) {
      wx.showToast({ title: '至少选择 2 个出发地', icon: 'none' })
      return
    }
    const room = { meetup: { people: valid } }
    const center = midpoint.average(room)
    this.setData({
      center,
      markers: midpoint.markers(room),
      localCalculated: true,
      mapSearchMessage: ''
    })
    this.searchLocalCandidates(center, ++this.localSearchVersion)
  },

  async searchLocalCandidates(center, searchVersion) {
    if (!amap.configuredKey()) {
      this.setData({
        amapConfigured: false,
        mapSearchMessage: '未配置地图搜索；可继续用“从地图添加候选地点”手动选点。'
      })
      return
    }
    this.setData({ amapConfigured: true, mapSearchMessage: '正在搜索中点附近的真实地点…' })
    try {
      const places = await amap.nearby(center)
      const candidates = places.map((place) => Object.assign({}, place, {
        dist: distanceMeters(center, place),
        isMall: /商场|购物/.test(place.typeStr),
        isDrink: /餐饮|咖啡|茶/.test(place.typeStr)
      })).slice(0, 12)
      if (searchVersion !== this.localSearchVersion) return
      this.rememberCandidateDetails(candidates)
      this.saveLocalState(this.data.localPoints, candidates)
      this.setData({
        localCandidates: candidates,
        mapSearchMessage: candidates.length ? `已找到 ${candidates.length} 个真实地点` : '附近没有可用结果；可改用地图手动选点。'
      })
    } catch (error) {
      if (searchVersion !== this.localSearchVersion) return
      this.setData({ mapSearchMessage: `${error.message || '地图搜索暂时不可用'} 可改用地图手动选点。` })
    }
  },

  async searchRoomCandidates() {
    if (!this.data.room || !this.data.center || this.roomSearchBusy || this.data.busy) return
    if (this.pendingMeetupMutation) {
      wx.showToast({ title: '请先等待出发点同步', icon: 'none' })
      return
    }
    const decision = currentDecision(this.data.room)
    if (decision.state === 'confirmed') return
    if (!amap.configuredKey()) {
      this.setData({ amapConfigured: false, mapSearchMessage: '请在微信地图中搜索并选择一个候选地点。' })
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
    this.setData({ amapConfigured: true, mapSearchMessage: '正在搜索参考中点附近的真实地点…' })
    try {
      const places = await amap.nearby(searchCenter)
      const latestCenter = this.data.center
      const latestDecision = currentDecision(this.data.room)
      const centerChanged = !latestCenter ||
        Math.abs(Number(latestCenter.latitude) - searchCenter.latitude) > 0.000001 ||
        Math.abs(Number(latestCenter.longitude) - searchCenter.longitude) > 0.000001
      if (this.docId !== searchRoomId || (latestDecision.roundId || 'initial') !== searchRoundId || centerChanged) return
      const candidates = places.map((place) => Object.assign({}, place, {
        dist: distanceMeters(searchCenter, place),
        isMall: /商场|购物/.test(place.typeStr),
        isDrink: /餐饮|咖啡|茶/.test(place.typeStr)
      })).slice(0, 12)
      if (!candidates.length) {
        this.setData({ mapSearchMessage: '附近没有可用结果；可改用地图手动选点。' })
        return
      }
      this.rememberCandidateDetails(candidates)
      const saved = await this.runDecisionMutation(
        'publishDecisionCandidates',
        { candidates },
        '发布附近候选地点失败'
      )
      if (saved) this.setData({ mapSearchMessage: `已发布 ${candidates.length} 个真实地点，大家可以一起投票。` })
    } catch (error) {
      this.setData({ mapSearchMessage: `${error.message || '地图搜索暂时不可用'} 可改用地图手动选点。` })
    } finally {
      this.roomSearchBusy = false
      this.maybeAutoSearchRoomCandidates()
    }
  },

  mineNameInput(event) {
    this.mineDraftDirty = true
    this.setData({ mineName: String(event.detail.value || '').slice(0, 24) })
  },

  mineAddressInput(event) {
    const mineAddress = String(event.detail.value || '').slice(0, 120)
    this.mineDraftDirty = true
    this.setData({ mineAddress, mineLocation: null, addressSuggestionsVisible: false })
    if (this.addressSearchTimer) clearTimeout(this.addressSearchTimer)
    this.addressSearchTimer = setTimeout(() => {
      this.addressSearchTimer = null
      this.searchAddressSuggestions(mineAddress)
    }, 260)
  },

  mineAddressFocus() {
    if (this.data.addressSuggestions.length) {
      this.setData({ addressSuggestionsVisible: true })
      return
    }
    this.searchAddressSuggestions(this.data.mineAddress)
  },

  async searchAddressSuggestions(query) {
    const value = String(query || '').trim()
    const request = ++this.addressSearchRequest
    if (value.length < 2) {
      this.setData({ addressSuggestions: [], addressSuggestionsVisible: false, addressSearchLoading: false })
      return
    }
    if (!amap.configuredKey()) {
      this.setData({ amapConfigured: false, addressSuggestions: [], addressSuggestionsVisible: false })
      return
    }
    this.setData({ amapConfigured: true, addressSearchLoading: true })
    try {
      const suggestions = await amap.inputTips(value)
      if (request !== this.addressSearchRequest || value !== String(this.data.mineAddress || '').trim()) return
      this.setData({
        addressSuggestions: suggestions,
        addressSuggestionsVisible: true,
        addressSearchLoading: false
      })
    } catch (error) {
      if (request !== this.addressSearchRequest) return
      this.setData({ addressSuggestions: [], addressSuggestionsVisible: false, addressSearchLoading: false })
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
    this.setData({
      mineAddress: selectedAddress,
      mineLocation: { lat: suggestion.lat, lng: suggestion.lng, address: selectedAddress },
      addressSuggestionsVisible: false
    })
  },

  async saveMeetupLocation() {
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
    const viewer = this.viewer
    if (!viewer || !viewer.uid || !viewer.membershipEpoch || this.data.busy) return
    const result = await new Promise((resolve) => wx.showModal({
      title: '清除我的出发点？',
      content: '清除后不会再参与中点计算。',
      success: resolve,
      fail: () => resolve({ confirm: false })
    }))
    if (!result.confirm) return
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
    if (!this.data.room || this.data.busy) return false
    const base = this.decisionMutationBase()
    if (!base) {
      wx.showToast({ title: '成员身份尚未同步，请稍后重试', icon: 'none' })
      return false
    }
    this.setData({ busy: true })
    try {
      await gateway[action](Object.assign(base, extra || {}))
      await this.fetchRoom()
      return true
    } catch (error) {
      if (['STALE_MEMBERSHIP', 'STALE_DECISION', 'DECISION_CONFIRMED', 'CANDIDATE_NOT_FOUND'].includes(error.code)) {
        await this.fetchRoom()
      }
      wx.showToast({ title: error.message || fallbackMessage, icon: 'none' })
      return false
    } finally {
      this.setData({ busy: false })
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
      this.setData({ localCandidates: candidates })
    })
  },

  removeLocalCandidate(event) {
    const id = String(event.currentTarget.dataset.id || '')
    this.localSearchVersion += 1
    const candidates = this.data.localCandidates.filter((candidate) => String(candidate.id) !== id)
    this.saveLocalState(this.data.localPoints, candidates)
    this.setData({ localCandidates: candidates })
  },

  activeSwipeCandidates() {
    return this.data.room ? this.data.decisionCandidates : this.data.localCandidates
  },

  startSwipe() {
    const deck = this.activeSwipeCandidates().map((candidate) => Object.assign({}, candidate, {
      initial: String(candidate.name || '?').slice(0, 1)
    }))
    if (!deck.length) {
      wx.showToast({ title: '先添加几个候选去处', icon: 'none' })
      return
    }
    this.setData({
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
    const current = this.data.swipeCurrent
    if (!current || this.data.swipeVoteBusy || !['like', 'pass'].includes(action)) return
    if (this.data.room && !this.data.decisionConfirmed) {
      this.setData({ swipeVoteBusy: true })
      const saved = await this.runDecisionMutation(
        'setDecisionVote',
        { candidateId: current.id, value: action === 'like' ? 'want' : 'no' },
        '保存盲盒选择失败'
      )
      this.setData({ swipeVoteBusy: false })
      if (!saved) return
    }
    const likes = action === 'like' ? this.data.swipeLikes.concat(current) : this.data.swipeLikes
    const nextIndex = this.data.swipeIndex + 1
    const finished = nextIndex >= this.data.swipeDeck.length
    this.setData({
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
    this.setData({ swipeFlipped: !this.data.swipeFlipped })
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
    this.setData({ swipeDragX: delta, swipeCardStyle: `transform: translateX(${delta}px) rotate(${delta / 16}deg);` })
  },

  swipeTouchEnd() {
    if (this.data.swipeFlipped) return
    const delta = Number(this.data.swipeDragX) || 0
    this.swipeStartX = null
    if (Math.abs(delta) >= 90) {
      this.takeSwipeAction(delta > 0 ? 'like' : 'pass')
      return
    }
    this.setData({ swipeDragX: 0, swipeCardStyle: '' })
  },

  restartSwipe() {
    const deck = this.data.swipeDeck
    this.setData({
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
    this.setData({ screen: 'main', swipeCurrent: null, swipeFinished: false })
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

  exitRoom() {
    const room = this.data.room
    if (!room || this.data.busy) return
    const action = this.data.isOwner ? 'disband' : 'leave'
    wx.showModal({
      title: this.data.isOwner ? '解散这个房间？' : '退出这个房间？',
      content: this.data.isOwner ? '解散后，所有成员都无法再进入。' : '退出后可凭房间码重新加入。',
      success: async (result) => {
        if (!result.confirm) return
        this.setData({ busy: true })
        try {
          await gateway[action](this.docId)
          this.clearPointOutbox(this.docId)
          storage.remove(this.docId)
          this.stopPolling()
          wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
        } catch (error) {
          wx.showToast({ title: error.message || '操作失败，请重试', icon: 'none' })
        } finally {
          this.setData({ busy: false })
        }
      }
    })
  }
})
