const gateway = require('../../services/roomGateway')
const storage = require('../../utils/storage')
const midpoint = require('../../utils/midpoint')
const layout = require('../../utils/layout')
const LOCAL_MIDPOINT_KEY = 'pintu-local-midpoint-v2'

function emptyLocalPoints() {
  return [
    { id: 'local-1', name: '地点 1', address: '', lat: null, lng: null },
    { id: 'local-2', name: '地点 2', address: '', lat: null, lng: null }
  ]
}

function validLocalState(value) {
  const points = value && Array.isArray(value.points) ? value.points : emptyLocalPoints()
  const candidates = value && Array.isArray(value.candidates) ? value.candidates : []
  return { points: points.length >= 2 ? points : emptyLocalPoints(), candidates }
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

function decisionCandidates(decision, viewer) {
  const uid = viewer && viewer.uid
  return decision.candidates.map((candidate) => {
    const votes = decision.votes.filter((vote) => vote && vote.candidateId === candidate.id)
    const myVote = (votes.find((vote) => vote.uid === uid) || {}).value || ''
    return Object.assign({}, candidate, {
      wantVotes: votes.filter((vote) => vote.value === 'want').length,
      okVotes: votes.filter((vote) => vote.value === 'ok').length,
      noVotes: votes.filter((vote) => vote.value === 'no').length,
      myVote,
      wantSelected: myVote === 'want',
      okSelected: myVote === 'ok',
      noSelected: myVote === 'no',
      isConfirmed: decision.confirmedCandidateId === candidate.id
    })
  })
}

function locationCandidate(location) {
  return {
    name: String(location.name || location.address || '地图地点').slice(0, 80),
    lat: Number(location.latitude),
    lng: Number(location.longitude),
    typeStr: String(location.address || '地图选择地点').slice(0, 120),
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
    localPoints: emptyLocalPoints(),
    localCandidates: [],
    localCalculated: false,
    screen: 'main',
    swipeDeck: [],
    swipeIndex: 0,
    swipeCurrent: null,
    swipeLikes: [],
    swipeFinished: false,
    headerTopPx: 72,
    isOwner: false,
    busy: false,
    syncText: '已同步'
  },

  onLoad(options) {
    this.docId = (options && options.docId) || ''
    this.viewer = null
    const localState = validLocalState(wx.getStorageSync(LOCAL_MIDPOINT_KEY))
    this.setData({
      name: storage.getName(),
      headerTopPx: layout.headerTopPx(),
      localPoints: localState.points.map((point, index) => Object.assign({}, point, {
        initial: String(point.name || `地点 ${index + 1}`).slice(0, 1)
      })),
      localCandidates: localState.candidates
    })
  },

  onShow() {
    if (this.docId) this.startPolling()
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
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

  nameInput(event) {
    this.setData({ name: event.detail.value })
  },

  codeInput(event) {
    this.setData({ code: cleanCode(event.detail.value) })
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
    const name = this.data.name.trim()
    if (!name) {
      wx.showToast({ title: '先填写名字', icon: 'none' })
      return
    }
    this.pendingCreateId = this.pendingCreateId || requestId()
    this.setData({ busy: true })
    try {
      const result = await gateway.create(roomInput(name), this.pendingCreateId)
      this.pendingCreateId = ''
      storage.saveName(name)
      this.docId = result.docId
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
    if (!this.docId || this.fetchBusy) return
    this.fetchBusy = true
    try {
      const result = await gateway.getRoom(this.docId)
      this.lastFetchError = false
      if (!result.room) {
        const removedId = this.docId
        this.docId = ''
        this.stopPolling()
        storage.remove(removedId)
        this.setData({ room: null, syncText: '房间已结束' })
        wx.showToast({ title: '房间已解散或你已退出', icon: 'none' })
        return
      }
      storage.save({ docId: this.docId, room: result.room })
      this.applyRoom(result.room, result.viewer)
      this.setData({ syncText: '已同步' })
    } catch (error) {
      this.setData({ syncText: '同步重试中' })
      if (!this.lastFetchError) {
        wx.showToast({ title: error.message || '同步暂时中断', icon: 'none' })
      }
      this.lastFetchError = true
    } finally {
      this.fetchBusy = false
    }
  },

  applyRoom(room, viewer) {
    this.viewer = viewer || null
    const decision = currentDecision(room)
    this.setData({
      room,
      people: (room.meetup && room.meetup.people) || [],
      center: midpoint.average(room),
      markers: midpoint.markers(room),
      decision,
      decisionCandidates: decisionCandidates(decision, this.viewer),
      decisionConfirmed: decision.state === 'confirmed',
      isOwner: Boolean(this.viewer && this.viewer.isOwner)
    })
  },

  async requestLocation(onSuccess) {
    if (this.data.busy) return
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
    this.requestLocation((location) => this.saveMeetupLocation(location))
  },

  saveLocalState(points, candidates) {
    wx.setStorageSync(LOCAL_MIDPOINT_KEY, { points, candidates })
  },

  addLocalPoint() {
    if (this.data.localPoints.length >= 10) {
      wx.showToast({ title: '最多添加 10 个出发地', icon: 'none' })
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
    this.saveLocalState(points, this.data.localCandidates)
    this.setData({ localPoints: points, localCalculated: false, center: null, markers: [] })
  },

  removeLocalPoint(event) {
    if (this.data.localPoints.length <= 2) {
      wx.showToast({ title: '至少保留 2 个出发地', icon: 'none' })
      return
    }
    const id = String(event.currentTarget.dataset.id || '')
    const points = this.data.localPoints.filter((point) => String(point.id) !== id)
    this.saveLocalState(points, this.data.localCandidates)
    this.setData({ localPoints: points, localCalculated: false, center: null, markers: [] })
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
      this.saveLocalState(points, this.data.localCandidates)
      this.setData({ localPoints: points, localCalculated: false, center: null, markers: [] })
    })
  },

  calculateLocalMidpoint() {
    const valid = this.data.localPoints.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    if (valid.length < 2) {
      wx.showToast({ title: '至少选择 2 个出发地', icon: 'none' })
      return
    }
    const room = { meetup: { people: valid } }
    this.setData({
      center: midpoint.average(room),
      markers: midpoint.markers(room),
      localCalculated: true
    })
  },

  async saveMeetupLocation(location) {
    const viewer = this.viewer
    if (!viewer || !viewer.uid || !viewer.membershipEpoch) {
      wx.showToast({ title: '成员身份尚未同步，请稍后重试', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    try {
      await gateway.setMeetupPoint({
        docId: this.docId,
        membershipEpoch: viewer.membershipEpoch,
        roundId: currentDecision(this.data.room).roundId,
        mutationAt: Date.now(),
        person: {
          name: viewer.name,
          address: location.address || location.name,
          lat: location.latitude,
          lng: location.longitude
        }
      })
      await this.fetchRoom()
    } catch (error) {
      if (error.code === 'STALE_MEMBERSHIP') await this.fetchRoom()
      wx.showToast({ title: error.message || '保存地点失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
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
      const candidates = this.data.localCandidates.concat(candidate)
      this.saveLocalState(this.data.localPoints, candidates)
      this.setData({ localCandidates: candidates })
    })
  },

  removeLocalCandidate(event) {
    const id = String(event.currentTarget.dataset.id || '')
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
      swipeFinished: false
    })
  },

  swipeAction(event) {
    const action = event.currentTarget.dataset.action
    const current = this.data.swipeCurrent
    if (!current || !['like', 'pass'].includes(action)) return
    const likes = action === 'like' ? this.data.swipeLikes.concat(current) : this.data.swipeLikes
    const nextIndex = this.data.swipeIndex + 1
    const finished = nextIndex >= this.data.swipeDeck.length
    this.setData({
      swipeLikes: likes,
      swipeIndex: nextIndex,
      swipeCurrent: finished ? null : this.data.swipeDeck[nextIndex],
      swipeFinished: finished
    })
  },

  restartSwipe() {
    const deck = this.data.swipeDeck
    this.setData({ swipeIndex: 0, swipeCurrent: deck[0] || null, swipeLikes: [], swipeFinished: !deck.length })
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

  openCandidate(event) {
    const candidate = event.currentTarget.dataset || {}
    const latitude = Number(candidate.lat)
    const longitude = Number(candidate.lng)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return
    wx.openLocation({
      latitude,
      longitude,
      name: candidate.name || '共同候选地点',
      address: candidate.type || '',
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
