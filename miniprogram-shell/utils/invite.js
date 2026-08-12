const ROOM_CODE = /^[A-HJ-NP-Z2-9]{8}$/
const INVITE_TYPES = Object.freeze({
  midpoint: { label: '公平碰面', shareTitle: '邀请你加入公平碰面' },
  ledger: { label: '行程账本', shareTitle: '邀请你加入行程账本' }
})

function roomCode(value) {
  const code = String(value || '').trim().toUpperCase()
  return ROOM_CODE.test(code) ? code : ''
}

function inviteType(value) {
  const type = String(value || '').trim()
  return Object.prototype.hasOwnProperty.call(INVITE_TYPES, type) ? type : ''
}

function fromOptions(options) {
  const code = roomCode(options && options.code)
  const type = inviteType(options && options.type)
  return { code, type, valid: Boolean(code && type) }
}

function sharePath(code, type) {
  const safeCode = roomCode(code)
  const safeType = inviteType(type)
  return safeCode && safeType ? `/pages/home/index?code=${safeCode}&type=${safeType}` : '/pages/home/index'
}

function shareTitle(type) {
  const item = INVITE_TYPES[inviteType(type)]
  return item ? item.shareTitle : '邀请你加入房间'
}

module.exports = { INVITE_TYPES, roomCode, inviteType, fromOptions, sharePath, shareTitle }
