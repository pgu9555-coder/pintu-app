function validPeople(room) {
  return ((room.meetup && room.meetup.people) || []).filter(
    (person) => Number.isFinite(person.lat) && Number.isFinite(person.lng)
  )
}

function average(room) {
  const people = validPeople(room)
  if (people.length < 2) return null
  return {
    latitude: people.reduce((sum, person) => sum + person.lat, 0) / people.length,
    longitude: people.reduce((sum, person) => sum + person.lng, 0) / people.length
  }
}

function markers(room) {
  const people = validPeople(room)
  const result = people.map((person, index) => ({
    id: index + 1,
    latitude: person.lat,
    longitude: person.lng,
    title: person.name,
    callout: { content: person.name, display: 'BYCLICK' }
  }))
  const center = average(room)
  if (center) {
    result.push({
      id: 9999,
      latitude: center.latitude,
      longitude: center.longitude,
      title: '参考中点',
      zIndex: 10,
      callout: { content: '参考中点', display: 'ALWAYS', padding: 6, borderRadius: 6 }
    })
  }
  return result
}

module.exports = { average, markers, validPeople }
