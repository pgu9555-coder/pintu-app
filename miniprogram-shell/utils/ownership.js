const gateway = require('../services/roomGateway')

module.exports = async function transferOwnership(page) {
  if (page.data.busy || !page.docId) return
  page.setData({ busy: true })
  try {
    const latest = await gateway.getRoom(page.docId)
    if (!latest.room || !latest.viewer || !latest.viewer.isOwner) throw new Error('只有当前房主可以转交权限')
    const candidates = (latest.room.members || []).filter(member => member.uid && member.uid !== latest.viewer.uid)
    if (!candidates.length) throw new Error('请先让接收人加入房间')
    // WeChat action sheets allow at most six items. Reserve one for navigation.
    let target, offset = 0
    while (!target) {
      const visible = candidates.slice(offset, offset + 5)
      const labels = visible.map(member => `${member.name}${member.uid.startsWith('wx:') ? '（微信）' : '（网页）'}`)
      if (candidates.length > 5) labels.push(offset + 5 < candidates.length ? '下一页成员' : '返回第一页')
      const pick = await wx.showActionSheet({ itemList: labels })
      if (pick.tapIndex < visible.length) target = visible[pick.tapIndex]
      else offset = offset + 5 < candidates.length ? offset + 5 : 0
    }
    if (!target) return
    const answer = await wx.showModal({ title: '转交房主？', content: `确认交给“${target.name}”？对方将可解散房间，你将成为普通成员。`, confirmText: '确认转交' })
    if (!answer.confirm) return
    const result = await gateway.transferOwnership(page.docId, target.uid, latest.viewer.membershipEpoch)
    page.applyRoom(result.room, result.viewer)
    wx.showToast({ title: '房主已转交', icon: 'success' })
  } catch (error) {
    if (!/cancel/i.test(error.errMsg || '')) wx.showToast({ title: error.message || '转交失败，请稍后重试', icon: 'none' })
  } finally { page.setData({ busy: false }) }
}
