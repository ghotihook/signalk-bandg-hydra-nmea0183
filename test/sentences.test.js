'use strict'

// End-to-end: drive the plugin with a mock Signal K app, catch what it puts on
// the wire, and check it against the sentence diagrams in the Hydra 2000 manual
// (Part 6, Diagnostic Data).

const { test } = require('node:test')
const assert   = require('node:assert')
const net      = require('node:net')

const makePlugin = require('..')

// Field counts from the manual, talker included:
//   RMC  $aaRMC,time,a,lat,n,lon,w,sog,cog,date,var,e
//   RMB  $aaRMB,a,xte,l,orig,dest,lat,n,lon,w,dist,brg,vmg,arr
//   APA  $aaAPA,A,A,xte,L,N,A,A,brg,M,cccc
//   XTE  $aaXTE,a,a,xte,l,N
const MANUAL_FIELDS = { NPRMC: 12, NPRMB: 14, NPAPA: 11, NPXTE: 6 }

// Where the validity flag sits in each sentence. RMC leads with UTC, so its
// status is one field further along than the others'.
const STATUS_FIELD = { NPRMC: 2, NPRMB: 1, NPAPA: 1, NPXTE: 1 }

function mockApp (overrides = {}) {
  const data = {
    'navigation.position': {
      value: { latitude: -33.868, longitude: 151.209 },
      timestamp: new Date().toISOString()
    },
    'navigation.speedOverGround':                        { value: 3.2 },
    'navigation.courseOverGroundTrue':                   { value: 0.785 },
    'navigation.magneticVariation':                      { value: 0.216 },
    'navigation.course.calcValues.distance':             { value: 2400 },
    'navigation.course.calcValues.crossTrackError':      { value: 37 },
    'navigation.course.calcValues.bearingTrue':          { value: 0.84 },
    'navigation.course.calcValues.velocityMadeGood':     { value: 2.9 },
    'navigation.course.calcValues.bearingTrackMagnetic': { value: 0.83 },
    ...overrides
  }
  const state = { status: '', error: '', data }
  return {
    state,
    getSelfPath: (p) => data[p],
    debug: () => {},
    setPluginStatus: (s) => { state.status = s },
    setPluginError:  (e) => { state.error = e }
  }
}

// Start the plugin pointed at a throwaway listener and collect one burst.
async function capture (app, options = {}, settleMs = 400) {
  const lines  = []
  const server = net.createServer((s) =>
    s.on('data', (d) => lines.push(...d.toString().split('\r\n').filter(Boolean))))

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const plugin = makePlugin(app)
  plugin.start({ transport: 'tcp', host: '127.0.0.1', port: server.address().port, rateHz: 10, ...options })

  await new Promise((r) => setTimeout(r, settleMs))
  return { lines, plugin, close: () => { plugin.stop(); server.close() } }
}

const bodyOf  = (s) => s.slice(1, s.lastIndexOf('*'))
const typeOf  = (s) => s.slice(1, 6)
const fields  = (s) => bodyOf(s).split(',')

test('exposes the interface the Signal K server requires', () => {
  const plugin = makePlugin(mockApp())
  for (const key of ['id', 'name', 'description', 'schema', 'start', 'stop']) {
    assert.ok(key in plugin, `plugin is missing ${key}`)
  }
  assert.equal(plugin.id, require('../package.json').name,
    'plugin.id must match the package name — the server keys stored config on it')
  assert.equal(typeof plugin.start, 'function')
  assert.equal(typeof plugin.stop, 'function')
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(plugin.schema)))
})

test('every configuration property carries a title and a default', () => {
  const { properties } = makePlugin(mockApp()).schema
  for (const [name, spec] of Object.entries(properties)) {
    assert.ok(spec.title, `${name} has no title — the admin UI would show a bare key`)
    assert.ok('default' in spec, `${name} has no default`)
  }
})

test('transmits all four sentence types with valid checksums', async () => {
  const app = mockApp()
  const { lines, close } = await capture(app)
  try {
    assert.ok(lines.length > 0, 'nothing was transmitted')
    assert.deepEqual([...new Set(lines.map(typeOf))].sort(), ['NPAPA', 'NPRMB', 'NPRMC', 'NPXTE'])

    for (const line of lines) {
      const m = line.match(/^\$(.+)\*([0-9A-F]{2})$/)
      assert.ok(m, `malformed sentence: ${JSON.stringify(line)}`)
      let c = 0
      for (const ch of m[1]) c ^= ch.charCodeAt(0)
      assert.equal(c.toString(16).toUpperCase().padStart(2, '0'), m[2], `bad checksum: ${line}`)
    }
  } finally { close() }
})

test('field counts match the manual', async () => {
  const { lines, close } = await capture(mockApp())
  try {
    for (const line of lines) {
      assert.equal(fields(line).length, MANUAL_FIELDS[typeOf(line)], `wrong field count: ${line}`)
    }
  } finally { close() }
})

test('bearings are integer degrees, coordinates are fixed width', async () => {
  const { lines, close } = await capture(mockApp())
  try {
    const rmc = fields(lines.find((l) => typeOf(l) === 'NPRMC'))
    assert.match(rmc[8], /^\d{3}$/, 'RMC COG must be a bare xxx field')
    assert.match(rmc[10], /^\d{2}$/, 'RMC variation must be a bare xx field')
    assert.match(rmc[3], /^\d{4}\.\d{2}$/, 'RMC latitude must be ddmm.mm')
    assert.match(rmc[5], /^\d{5}\.\d{2}$/, 'RMC longitude must be dddmm.mm')

    assert.match(fields(lines.find((l) => typeOf(l) === 'NPRMB'))[11], /^\d{3}$/,
      'RMB bearing must be a bare xxx field')
    assert.match(fields(lines.find((l) => typeOf(l) === 'NPAPA'))[8], /^\d{3}$/,
      'APA track must be a bare xxx field')
  } finally { close() }
})

test('a stale position is not transmitted at all', async () => {
  // Signal K serves the last known position forever. A GPS that loses lock
  // leaves a frozen fix that would otherwise go out with a fresh timestamp,
  // and the processor would navigate on it.
  const app = mockApp()
  app.state.data['navigation.position'].timestamp = new Date(Date.now() - 60000).toISOString()

  const { lines, close } = await capture(app, { maxPositionAge: 10 })
  try {
    assert.equal(lines.length, 0, `transmitted on a stale fix: ${lines[0]}`)
    assert.match(app.state.error, /Position is 6\ds old/)
  } finally { close() }
})

test('transmission resumes once the position is fresh again', async () => {
  const app = mockApp()
  app.state.data['navigation.position'].timestamp = new Date(Date.now() - 60000).toISOString()

  const { lines, close } = await capture(app, { maxPositionAge: 10 })
  try {
    assert.equal(lines.length, 0)
    app.state.data['navigation.position'].timestamp = new Date().toISOString()
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(lines.length > 0, 'stayed silent after the fix recovered')
    assert.equal(fields(lines.find((l) => typeOf(l) === 'NPRMC'))[STATUS_FIELD.NPRMC], 'A')
  } finally { close() }
})

test('a fresh position is sent as valid', async () => {
  const app = mockApp()
  const { lines, close } = await capture(app, { maxPositionAge: 10 })
  try {
    assert.equal(fields(lines.find((l) => typeOf(l) === 'NPRMC'))[STATUS_FIELD.NPRMC], 'A')
    assert.match(app.state.status, /^Active/)
  } finally { close() }
})

test('the staleness check can be disabled', async () => {
  const app = mockApp()
  app.state.data['navigation.position'].timestamp = new Date(Date.now() - 86400000).toISOString()

  const { lines, close } = await capture(app, { maxPositionAge: 0 })
  try {
    assert.equal(fields(lines.find((l) => typeOf(l) === 'NPRMC'))[STATUS_FIELD.NPRMC], 'A')
  } finally { close() }
})

test('a source publishing no timestamp is treated as current', async () => {
  const app = mockApp()
  delete app.state.data['navigation.position'].timestamp

  const { lines, close } = await capture(app)
  try {
    assert.equal(fields(lines.find((l) => typeOf(l) === 'NPRMC'))[STATUS_FIELD.NPRMC], 'A')
  } finally { close() }
})

test('a waypoint label cannot break sentence framing', async () => {
  // A comma would split the sentence into bogus fields; an asterisk would
  // truncate it at a false checksum delimiter.
  const { lines, close } = await capture(mockApp(), { waypointName: 'ev,il*name' })
  try {
    const rmb = fields(lines.find((l) => typeOf(l) === 'NPRMB'))
    assert.equal(rmb.length, MANUAL_FIELDS.NPRMB)
    assert.match(rmb[5], /^[A-Z0-9]{0,4}$/)
  } finally { close() }
})

test('sentences are suppressed when there is no position at all', async () => {
  const app = mockApp({ 'navigation.position': undefined })
  const { lines, close } = await capture(app)
  try {
    assert.equal(lines.length, 0, 'transmitted without a fix')
    assert.match(app.state.error, /No position fix/)
  } finally { close() }
})

test('course sentences are omitted when no course is active', async () => {
  const app = mockApp({ 'navigation.course.calcValues.distance': undefined })
  const { lines, close } = await capture(app)
  try {
    assert.deepEqual([...new Set(lines.map(typeOf))], ['NPRMC'])
  } finally { close() }
})

test('individual sentences can be switched off', async () => {
  const { lines, close } = await capture(mockApp(), { sendRMC: false, sendAPA: false })
  try {
    const seen = new Set(lines.map(typeOf))
    assert.ok(!seen.has('NPRMC'))
    assert.ok(!seen.has('NPAPA'))
    assert.ok(seen.has('NPRMB'))
  } finally { close() }
})

test('stop() releases the timer and the socket', async () => {
  const before = process._getActiveHandles().length
  const { plugin, close } = await capture(mockApp(), {}, 200)
  plugin.stop()
  await new Promise((r) => setTimeout(r, 200))
  close()
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(process._getActiveHandles().length <= before + 1,
    'stop() left timers or sockets behind')
})

test('an unreachable destination is reported, not thrown', async () => {
  const app    = mockApp()
  const plugin = makePlugin(app)
  // Port 1 on loopback refuses immediately.
  plugin.start({ transport: 'tcp', host: '127.0.0.1', port: 1, rateHz: 10 })
  await new Promise((r) => setTimeout(r, 400))
  assert.match(app.state.error, /No link to tcp/)
  plugin.stop()
})

test('udp opens without a listener present', async () => {
  const app    = mockApp()
  const plugin = makePlugin(app)
  plugin.start({ transport: 'udp', host: '127.0.0.1', port: 59999, rateHz: 10 })
  await new Promise((r) => setTimeout(r, 400))
  assert.match(app.state.status, /Active →udp/)
  plugin.stop()
})
