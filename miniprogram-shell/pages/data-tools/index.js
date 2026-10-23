const storage = require('../../utils/storage')
const backup = require('../../utils/ledger-backup')

Page({
  data: { status: '', busy: false, localCount: 0, cachedCount: 0, scopeLabel: '' },

  onShow() {
    const local = storage.getLocal(backup.LOCAL_KEY, { trips: [] })
    this.setData({
      localCount: Array.isArray(local && local.trips) ? local.trips.length : 0,
      cachedCount: storage.getLedgerBackupCache().length,
      scopeLabel: storage.isAccountScoped() ? '当前微信账号的本机空间' : '游客本机空间'
    })
  },

  finish(status) {
    this.setData({ busy: false, status })
    this.onShow()
  },

  exportBackup() {
    if (this.data.busy) return
    try {
      const local = storage.getLocal(backup.LOCAL_KEY, { trips: [] })
      const result = backup.createBackup(local && local.trips, storage.getLedgerBackupCache())
      if (!result.data.trips.length) { this.setData({ status: '暂无可备份的账本。' }); return }
      if (typeof wx.shareFileMessage !== 'function') { this.setData({ status: '当前微信版本暂不支持分享文件，请升级微信后重试。' }); return }
      const token = storage.localScopeToken()
      this.setData({ busy: true, status: '正在生成备份…' })
      const fileName = `pintu-ledgers-${result.data.exportedAt.slice(0, 10)}.json`
      const filePath = `${wx.env.USER_DATA_PATH}/pintu-backup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}.json`
      const manager = wx.getFileSystemManager()
      const remove = () => manager.unlink({ filePath, fail() {} })
      manager.writeFile({
        filePath, data: result.text, encoding: 'utf8',
        success: () => {
          if (token !== storage.localScopeToken()) { remove(); this.finish('账号空间已切换，请重新导出。'); return }
          wx.shareFileMessage({
            filePath, fileName,
            success: () => this.finish(`已交给微信发送 ${result.data.trips.length} 个账本，请确认文件已妥善保存。`),
            fail: (error) => this.finish(/cancel/i.test(error && error.errMsg || '') ? '已取消分享，账本未修改。' : '文件发送失败，请重试。账本未修改。'),
            complete: remove
          })
        },
        fail: () => { remove(); this.finish('生成备份失败，请检查本机可用空间后重试。') }
      })
    } catch (error) { this.finish(error.message || '备份失败，请检查账本后重试。') }
  },

  importBackup() {
    if (this.data.busy) return
    if (typeof wx.chooseMessageFile !== 'function') { this.setData({ status: '当前微信版本暂不支持选择文件，请升级微信后重试。' }); return }
    const token = storage.localScopeToken()
    this.setData({ busy: true, status: '请选择微信聊天中的 JSON 账本备份。' })
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['json'],
      success: (result) => {
        const file = result.tempFiles && result.tempFiles[0]
        if (!file || !file.path || !Number.isFinite(file.size) || file.size > backup.MAX_BYTES) { this.finish('请选择不超过 5MB 的 JSON 备份。'); return }
        wx.getFileSystemManager().readFile({
          filePath: file.path, encoding: 'utf8',
          success: (read) => {
            try {
              if (token !== storage.localScopeToken()) throw new Error('账号空间已切换，请重新选择文件。')
              const trips = backup.parseBackup(read.data)
              const count = backup.importTrips(storage, trips)
              this.finish(`已新增 ${count} 个独立本机账本，可在“行程”中查看。`)
            } catch (error) { this.finish(`导入失败：${error.message || '文件格式无效'}。现有账本未修改。`) }
          },
          fail: () => this.finish('无法读取这个文件，请重新选择。现有账本未修改。')
        })
      },
      fail: (error) => this.finish(/cancel/i.test(error && error.errMsg || '') ? '已取消导入，账本未修改。' : '选择文件失败，请重试。')
    })
  },

  openTrips() { wx.switchTab({ url: '/pages/trips/index' }) }
})
