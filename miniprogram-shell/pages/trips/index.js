const storage = require('../../utils/storage')
const gateway = require('../../services/roomGateway')
const layout = require('../../utils/layout')

const PAGE_BY_TYPE = {
  midpoint: '/pages/midpoint/index',
  ledger: '/pages/ledger/index'
}

function displayRoom(entry) {
  const isMidpoint = entry.room.toolType === 'midpoint'
  return Object.assign({}, entry, {
    typeLabel: isMidpoint ? '碰面' : '账本',
    typeIcon: isMidpoint ? '/assets/icons/midpoint.svg' : '/assets/icons/receipt.svg',
    iconTone: isMidpoint ? 'meetup' : 'ledger',
    totalYuan: (Number(entry.totalCents || 0) / 100).toFixed(2),
    showTotal: !isMidpoint && Number(entry.totalCents || 0) > 0
  })
}

function uniqueRooms(rooms) {
  const seen = new Set()
  return rooms.filter((entry) => {
    if (!entry || !entry.docId || !entry.room || seen.has(entry.docId)) return false
    seen.add(entry.docId)
    return true
  })
}

Page({
  data: {
    rooms: [],
    loading: false,
    loadingMore: false,
    cloudError: '',
    hasMore: false,
    nextCursor: null,
    headerTopPx: 72
  },

  onLoad() {
    this.setData({ headerTopPx: layout.headerTopPx() })
  },

  onShow() {
    this.refresh()
  },

  async refresh() {
    const requestId = (this.myRoomsRequestId || 0) + 1
    this.myRoomsRequestId = requestId
    this.setData({
      rooms: [],
      loading: true,
      loadingMore: false,
      cloudError: '',
      hasMore: false,
      nextCursor: null
    })
    try {
      const result = await gateway.listMyRooms(null, 50)
      if (requestId !== this.myRoomsRequestId) return
      const rooms = uniqueRooms(Array.isArray(result.rooms) ? result.rooms : [])
      this.setData({
        rooms: rooms.map(displayRoom),
        loading: false,
        cloudError: '',
        hasMore: Boolean(result.hasMore),
        nextCursor: result.nextCursor && typeof result.nextCursor === 'object' ? result.nextCursor : null
      })
    } catch (error) {
      if (requestId !== this.myRoomsRequestId) return
      this.setData({
        rooms: [],
        loading: false,
        cloudError: error.message || '云端房间暂时无法加载',
        hasMore: false,
        nextCursor: null
      })
    }
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return
    const requestId = this.myRoomsRequestId || 0
    const cursor = this.data.nextCursor
    if (!cursor || !Number.isSafeInteger(cursor.createdAt) || !cursor.docId) return
    this.setData({ loadingMore: true, cloudError: '' })
    try {
      const result = await gateway.listMyRooms(cursor, 50)
      if (requestId !== this.myRoomsRequestId) return
      const rooms = uniqueRooms(this.data.rooms.concat(Array.isArray(result.rooms) ? result.rooms : []))
      this.setData({
        rooms: rooms.map(displayRoom),
        loadingMore: false,
        hasMore: Boolean(result.hasMore),
        nextCursor: result.nextCursor && typeof result.nextCursor === 'object' ? result.nextCursor : null
      })
    } catch (error) {
      if (requestId !== this.myRoomsRequestId) return
      this.setData({
        loadingMore: false,
        cloudError: error.message || '更多云端房间暂时无法加载'
      })
    }
  },

  open(event) {
    const { id } = event.currentTarget.dataset
    const entry = this.data.rooms.find((item) => item.docId === id)
    const page = entry && PAGE_BY_TYPE[entry.room.toolType]
    if (!page || !id || !entry) {
      wx.showToast({ title: '房间记录已失效', icon: 'none' })
      return
    }
    storage.save({ docId: entry.docId, room: entry.room })
    wx.navigateTo({
      url: `${page}?docId=${encodeURIComponent(id)}`,
      fail: () => wx.showToast({ title: '暂时无法打开房间', icon: 'none' })
    })
  }
})
