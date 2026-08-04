const storage = require('../../utils/storage')

const PAGE_BY_TYPE = {
  midpoint: '/pages/midpoint/index',
  ledger: '/pages/ledger/index'
}

function displayRoom(entry) {
  const isMidpoint = entry.room.toolType === 'midpoint'
  return Object.assign({}, entry, {
    typeLabel: isMidpoint ? '协作碰面' : '共享账本',
    typeIcon: isMidpoint ? '⌖' : '¥'
  })
}

Page({
  data: { rooms: [] },

  onShow() {
    this.refresh()
  },

  refresh() {
    this.setData({ rooms: storage.all().map(displayRoom) })
  },

  open(event) {
    const { id, type } = event.currentTarget.dataset
    const page = PAGE_BY_TYPE[type]
    if (!page || !id) {
      wx.showToast({ title: '这个本机记录已失效', icon: 'none' })
      return
    }
    wx.navigateTo({
      url: `${page}?docId=${encodeURIComponent(id)}`,
      fail: () => wx.showToast({ title: '暂时无法打开房间', icon: 'none' })
    })
  },

  remove(event) {
    const docId = event.currentTarget.dataset.id
    wx.showModal({
      title: '从最近列表移除？',
      content: '只移除这台手机上的入口，不会解散云端房间。以后仍可凭房间码加入。',
      success: (result) => {
        if (!result.confirm) return
        storage.remove(docId)
        this.refresh()
      }
    })
  }
})
