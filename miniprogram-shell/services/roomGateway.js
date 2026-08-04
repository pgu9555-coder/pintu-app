function call(action, data) {
  return wx.cloud
    .callFunction({
      name: 'roomGateway',
      data: Object.assign({ action }, data || {})
    })
    .then((response) => {
      const body = response.result || {}
      if (!body.ok) {
        const error = new Error(body.message || '房间服务暂不可用')
        error.code = body.code || 'GATEWAY_ERROR'
        throw error
      }
      return body.data
    })
    .catch((error) => {
      if (error && error.code && error.message) throw error
      const wrapped = new Error('网络或房间服务暂不可用，请稍后重试')
      wrapped.code = (error && error.errCode) || 'NETWORK_ERROR'
      wrapped.cause = error
      throw wrapped
    })
}

module.exports = {
  call,
  create(room, clientRequestId) {
    return call('create', { room, clientRequestId })
  },
  join(code, type, name) {
    return call('join', { code, type, name })
  },
  getRoom(docId) {
    return call('getRoom', { docId })
  },
  getProfile() {
    return call('getProfile')
  },
  updateProfile(data) {
    return call('updateProfile', data)
  },
  deleteProfile() {
    return call('deleteProfile')
  },
  retryAvatarCleanup() {
    return call('retryAvatarCleanup')
  },
  listMyRooms(cursor, limit) {
    return call('listMyRooms', { cursor, limit })
  },
  syncLedger(docId, ledger, membershipEpoch) {
    return call('syncLedger', { docId, ledger, membershipEpoch })
  },
  setMeetupPoint(data) {
    return call('setMeetupPoint', data)
  },
  publishDecisionCandidates(data) {
    return call('publishDecisionCandidates', data)
  },
  setDecisionVote(data) {
    return call('setDecisionVote', data)
  },
  confirmDecisionCandidate(data) {
    return call('confirmDecisionCandidate', data)
  },
  reopenDecision(data) {
    return call('reopenDecision', data)
  },
  leave(docId) {
    return call('leave', { docId })
  },
  disband(docId) {
    return call('disband', { docId })
  }
}
