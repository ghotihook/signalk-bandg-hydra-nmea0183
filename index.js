'use strict'

const net        = require('net')
const dgram      = require('dgram')
const RAD_TO_DEG = 180 / Math.PI
const DEG_TO_RAD = Math.PI / 180
const MS_TO_KN   = 1.943844   // m/s -> knots
const M_TO_NM    = 1 / 1852   // metres -> nautical miles
const EARTH_R    = 6371000    // mean earth radius, metres
const TWO_PI     = 2 * Math.PI

function nmeaChecksum(s) {
  let c = 0
  for (let i = 0; i < s.length; i++) c ^= s.charCodeAt(i)
  return c.toString(16).toUpperCase().padStart(2, '0')
}

// Build a checksummed NMEA 0183 sentence from its body (no leading '$').
// CRLF-terminated: we write to the wire ourselves, nothing else appends it.
function sentence(body) {
  return `$${body}*${nmeaChecksum(body)}\r\n`
}

// Decimal degrees -> ddmm.mm / dddmm.mm + hemisphere letter.
// 2 decimal minutes per the Hydra 2000 manual format (xxxx.xx / xxxxx.xx).
//
// Rounding happens once, to whole hundredths of a minute, *before* degrees and
// minutes are separated. Splitting first and formatting the remainder with
// toFixed(2) lets a minute value just under 60 round up to "60.00" and emit an
// invalid coordinate (34° came out as 3360.00 rather than 3400.00).
function ddmm(degrees, isLat) {
  const hemi       = isLat ? (degrees >= 0 ? 'N' : 'S') : (degrees >= 0 ? 'E' : 'W')
  const hundredths = Math.round(Math.abs(degrees) * 6000)  // 60 min x 100
  const d          = Math.floor(hundredths / 6000)
  const m          = (hundredths - d * 6000) / 100
  const deg        = String(d).padStart(isLat ? 2 : 3, '0')
  const min        = m.toFixed(2).padStart(5, '0')
  return [`${deg}${min}`, hemi]
}

// Bearings and courses -> integer degrees, zero-padded to 3, per the manual's
// bare `xxx` fields (RMC COG, RMB bearing, APA/BOD track). Normalises into
// 0-359 first, so an out-of-range input can't emit "0-3" or "360".
// Note this is 1 degree of resolution: the manual has no decimal place here.
function deg3(rad) {
  if (rad == null) return ''
  const d = Math.round(rad * RAD_TO_DEG)
  return String(((d % 360) + 360) % 360).padStart(3, '0')
}

// Great-circle destination from a start point, bearing (rad) and distance (m).
// Used to recover the waypoint lat/lon, which the v2-only Course API does not
// expose through app.getSelfPath (the v1 model holds only calcValues.*).
function destFrom(lat, lon, brgRad, distM) {
  const p1 = lat * DEG_TO_RAD
  const l1 = lon * DEG_TO_RAD
  const d  = distM / EARTH_R
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(brgRad))
  const l2 = l1 + Math.atan2(Math.sin(brgRad) * Math.sin(d) * Math.cos(p1),
                             Math.cos(d) - Math.sin(p1) * Math.sin(p2))
  return [p2 * RAD_TO_DEG, ((l2 * RAD_TO_DEG + 540) % 360) - 180]
}

module.exports = function (app) {
  const plugin = {
    id: 'signalk-bandg-hydra-nmea0183',
    name: 'gh - B&G Hydra Legacy NMEA 0183',
    description: 'Feeds legacy NMEA 0183 sentences (RMC, RMB, APA, XTE) into the NMEA input of an ' +
                 'older B&G H2000 processor (Hydra, Hercules) over TCP or UDP'
  }

  plugin.schema = {
    type: 'object',
    properties: {
      transport: {
        type: 'string',
        title: 'Transport',
        description: 'TCP opens a client connection to the destination and reports link state. ' +
                     'UDP is fire-and-forget: nothing confirms the instrument received anything, ' +
                     'but it suits devices that only listen, and broadcast addresses.',
        enum: ['tcp', 'udp'],
        enumNames: ['TCP (client connection)', 'UDP (datagrams)'],
        default: 'tcp'
      },
      host:          { type: 'string',  title: 'Destination address', default: '192.168.0.2' },
      port:          { type: 'number',  title: 'Destination port',    default: 1183 },
      connectTimeout: {
        type: 'number',
        title: 'TCP connect timeout (s)',
        description: 'TCP only. Prevents a destination that silently drops packets from stalling ' +
                     'for the operating system timeout (around two minutes) before retrying.',
        default: 5
      },
      rateHz:        { type: 'number',  title: 'Transmit rate (Hz)', default: 1, minimum: 0.1, maximum: 10 },
      waypointName: {
        type: 'string',
        title: 'Destination waypoint label',
        description: 'RMB and APA carry a 4-character waypoint identifier. The v1 data model ' +
                     'exposes waypoint hrefs rather than names, so there is no real name to send; ' +
                     'this fixed label fills the field so the processor has something to parse ' +
                     'and display. Clear it to leave the field empty.',
        default: 'WPT'
      },
      maxPositionAge: {
        type: 'number',
        title: 'Maximum position age (s)',
        description: 'Signal K keeps serving the last known position after a GPS drops out, with ' +
                     'nothing to mark it stale. Past this age the sentences are still sent, but ' +
                     'flagged invalid (status V) so the processor discards them instead of ' +
                     'navigating on a frozen fix. 0 disables the check.',
        default: 10
      },
      sendRMC:       { type: 'boolean', title: 'Send RMC (position, SOG, COG, date, variation)', default: true },
      sendRMB:       { type: 'boolean', title: 'Send RMB (active waypoint navigation)', default: true },
      sendAPA:       { type: 'boolean', title: 'Send APA (autopilot format A)', default: true },
      sendXTE:       { type: 'boolean', title: 'Send XTE (cross-track error)', default: true },
      arrivalRadius: { type: 'number',  title: 'Arrival radius (m) — RMB/APA arrival flags', default: 100 }
    }
  }

  let timer     = null
  let stopped   = true
  let socket    = null   // net.Socket (tcp) or dgram.Socket (udp)
  let connected = false  // tcp: link is up. udp: socket is open (delivery unknown)
  let reconnect = null
  let lastDrop  = null   // last drop reason, so repeats aren't logged; null = never dropped

  plugin.start = function (options) {
    stopped = false
    // host/port were tcpAddress/tcpPort before UDP was an option; fall back so
    // existing configurations keep working across the rename.
    const host       = options.host || options.tcpAddress || '192.168.0.2'
    const port       = options.port || options.tcpPort    || 1183
    const isUdp      = options.transport === 'udp'
    // Clamped: the schema bounds only guide the admin UI, and a hand-edited
    // config with a huge rate would round the interval down to a busy-loop.
    const rateHz     = Math.min(Math.max(options.rateHz > 0 ? options.rateHz : 1, 0.1), 10)
    const periodMs   = Math.round(1000 / rateHz)
    const sendRMC    = options.sendRMC !== false
    const sendRMB    = options.sendRMB !== false
    const sendAPA    = options.sendAPA !== false
    const sendXTE    = options.sendXTE !== false
    const arrivalR   = options.arrivalRadius > 0 ? options.arrivalRadius : 100
    // 0 disables; undefined (config saved before this option existed) gets the default.
    const maxAgeMs   = (options.maxPositionAge != null ? options.maxPositionAge : 10) * 1000

    // Waypoint identifier fields. Stripped to plain alphanumerics and 4 chars:
    // a comma or '*' from the config would otherwise split the sentence into
    // bogus fields or truncate it at a false checksum delimiter. Origin is left
    // blank — there is no meaningful label for it and the processor shows dest.
    const destId   = String(options.waypointName != null ? options.waypointName : 'WPT')
      .replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase()
    const originId = ''
    const connTimeoutMs = (options.connectTimeout > 0 ? options.connectTimeout : 5) * 1000

    const dest = `${isUdp ? 'udp' : 'tcp'} ${host}:${port}`

    // --- UDP: connectionless, so there is nothing to connect or reconnect. The
    // socket is opened once and datagrams are fired at the destination. Errors
    // (e.g. ICMP port unreachable) may surface asynchronously or not at all, so
    // "connected" here only means the socket is open, never that anything
    // received the data.
    function openUdp() {
      socket = dgram.createSocket('udp4')
      socket.on('error', (err) => {
        if (lastDrop !== err.message) app.debug(`udp error: ${err.message}`)
        lastDrop = err.message
      })
      socket.bind(() => {
        try {
          // Harmless for unicast, and required if the destination is a
          // broadcast address such as 192.168.0.255.
          socket.setBroadcast(true)
        } catch (e) {
          app.debug(`could not enable broadcast: ${e.message}`)
        }
        connected = true
        app.debug(`udp socket open, sending to ${host}:${port}`)
      })
    }

    // --- TCP: client connection with retry, as before.
    function connect() {
      if (stopped) return
      socket = new net.Socket()
      socket.setNoDelay(true)

      // Connect-phase timeout only: without it a host that blackholes packets
      // (rather than refusing them) sits in the OS SYN timeout for ~2 minutes
      // before erroring. Cleared once established so it can't kill an idle link.
      socket.setTimeout(connTimeoutMs)

      socket.on('connect', () => {
        socket.setTimeout(0)
        connected = true
        if (lastDrop !== null) app.debug(`connected to ${host}:${port}`)
        lastDrop = null
      })

      // One drop per socket: destroy() fires 'close' straight after 'error', and
      // the second call would otherwise overwrite the real reason with 'closed'.
      let dropped = false

      const drop = (why) => {
        if (dropped) return
        dropped = true
        // Log/annotate only on a change of state or reason, so a host that is
        // down doesn't flood the log every 5s — but the first failure is always
        // reported, including one that never connected in the first place.
        if (connected || lastDrop !== why) app.debug(`connection ${why}`)
        lastDrop = why
        connected = false
        if (socket) { socket.destroy(); socket = null }
        if (!stopped && !reconnect) {
          reconnect = setTimeout(() => { reconnect = null; connect() }, 5000)
        }
      }

      socket.on('timeout', () => drop(`connect timeout after ${connTimeoutMs / 1000}s`))
      socket.on('error', (err) => drop(`error: ${err.message}`))
      socket.on('close', () => drop('closed'))

      socket.connect(port, host)
    }

    function send(s) {
      if (!connected || !socket) return
      if (isUdp) {
        socket.send(s, port, host, (err) => {
          if (err) app.debug(`udp send error: ${err.message}`)
        })
      } else {
        socket.write(s, (err) => { if (err) app.debug(`tcp write error: ${err.message}`) })
      }
    }

    // Throttle (ms) for repeating diagnostic lines so debug doesn't flood at rateHz.
    let lastDiag = 0
    const diag = (msg) => {
      const now = Date.now()
      if (now - lastDiag >= 10000) { lastDiag = now; app.debug(msg) }
    }

    function transmit() {
      const posNode  = app.getSelfPath('navigation.position')
      const position = posNode?.value
      if (!position || position.latitude == null || position.longitude == null) {
        diag(`no position fix — navigation.position=${JSON.stringify(position)}; skipping transmit. ` +
             `cog=${JSON.stringify(app.getSelfPath('navigation.courseOverGroundTrue')?.value)} ` +
             `sog=${JSON.stringify(app.getSelfPath('navigation.speedOverGround')?.value)} ` +
             `var=${JSON.stringify(app.getSelfPath('navigation.magneticVariation')?.value)} ` +
             `course.dist=${JSON.stringify(app.getSelfPath('navigation.course.calcValues.distance')?.value)}`)
        // Report link state here too, otherwise a dead link plus no fix is silent.
        if (connected) app.setPluginError(`No position fix — nothing to send (→${dest})`)
        else app.setPluginError(`No link to ${dest}${lastDrop ? ` (${lastDrop})` : ''} and no position fix`)
        return
      }

      const [la, lh] = ddmm(position.latitude, true)
      const [lo, loh] = ddmm(position.longitude, false)

      const now = new Date()

      // Staleness. getSelfPath serves the last known position indefinitely — a
      // GPS that loses lock or dies leaves a frozen fix in the data model, and
      // sending it with status 'A' and a fresh timestamp would have the
      // processor navigate on it with no way to tell. Past maxAgeMs everything
      // goes out flagged invalid instead. A source that publishes no timestamp
      // can't be judged, so it is treated as current.
      const posAgeMs = posNode.timestamp != null
        ? now.getTime() - new Date(posNode.timestamp).getTime()
        : null
      const stale  = maxAgeMs > 0 && posAgeMs != null && posAgeMs > maxAgeMs
      const status = stale ? 'V' : 'A'
      if (stale) {
        diag(`position is ${Math.round(posAgeMs / 1000)}s old (limit ${maxAgeMs / 1000}s) — ` +
             `sending status V; timestamp=${posNode.timestamp}`)
      }

      const hh = String(now.getUTCHours()).padStart(2, '0')
      const mm = String(now.getUTCMinutes()).padStart(2, '0')
      const ss = String(now.getUTCSeconds()).padStart(2, '0')
      const ts = `${hh}${mm}${ss}`

      const varRad = app.getSelfPath('navigation.magneticVariation')?.value

      // COG, true (the RMC field is true-referenced). This vessel publishes only
      // navigation.courseOverGroundMagnetic, so derive true COG from magnetic +
      // variation when the true path is absent.
      let cogRad = app.getSelfPath('navigation.courseOverGroundTrue')?.value
      if (cogRad == null) {
        const cogMag = app.getSelfPath('navigation.courseOverGroundMagnetic')?.value
        if (cogMag != null && varRad != null) {
          cogRad = ((cogMag + varRad) % TWO_PI + TWO_PI) % TWO_PI
        }
      }
      const sogMs  = app.getSelfPath('navigation.speedOverGround')?.value
      const cogStr = deg3(cogRad)
      const sogStr = sogMs != null ? (sogMs * MS_TO_KN).toFixed(1) : ''

      // RMC — recommended minimum GPS data (position, SOG, COG, date, variation).
      // RMC already carries SOG (knots) and COG (true), so VTG is not sent.
      const dd   = String(now.getUTCDate()).padStart(2, '0')
      const mo   = String(now.getUTCMonth() + 1).padStart(2, '0')
      const yy   = String(now.getUTCFullYear() % 100).padStart(2, '0')
      const date = `${dd}${mo}${yy}`

      // Variation is a bare `xx` in the manual — whole degrees, magnitude only,
      // with the hemisphere carried in the following field.
      const varStr  = varRad != null
        ? String(Math.round(Math.abs(varRad * RAD_TO_DEG))).padStart(2, '0')
        : ''
      const varHemi = varRad != null ? (varRad >= 0 ? 'E' : 'W') : ''

      let rmcSent = false
      if (sendRMC) {
        const rmc = sentence(`NPRMC,${ts},${status},${la},${lh},${lo},${loh},${sogStr},${cogStr},${date},${varStr},${varHemi}`)
        send(rmc)
        app.debug(rmc)
        rmcSent = true
      }

      // Course / autopilot sentences (RMB, APA, XTE). The waypoint data
      // (nextPoint, etc.) lives only in the v2 Course API; getSelfPath sees the
      // v1 model, which carries just navigation.course.calcValues.*. A course is
      // active when those calc values are populated.
      const xteM    = app.getSelfPath('navigation.course.calcValues.crossTrackError')?.value
      const distM   = app.getSelfPath('navigation.course.calcValues.distance')?.value
      const brgRad  = app.getSelfPath('navigation.course.calcValues.bearingTrue')?.value
      const vmgMs   = app.getSelfPath('navigation.course.calcValues.velocityMadeGood')?.value
      const trkMag  = app.getSelfPath('navigation.course.calcValues.bearingTrackMagnetic')?.value
      const trkTrue = app.getSelfPath('navigation.course.calcValues.bearingTrackTrue')?.value

      let wptSent = false
      if (distM != null) {
        // Shared fields. SK crossTrackError: positive = vessel right of track ->
        // steer left to correct. Verify against live data; flip if the AP steers
        // the wrong way.
        const xteStr  = xteM != null ? Math.abs(xteM * M_TO_NM).toFixed(2) : ''
        const steer   = xteM != null ? (xteM >= 0 ? 'L' : 'R') : ''
        const arrived = distM <= arrivalR ? 'A' : 'V'

        // RMB — needs the waypoint position (bearing to it).
        if (sendRMB && brgRad != null) {
          // Recover the waypoint position from our position + bearing + distance.
          const [dLat, dLon] = destFrom(position.latitude, position.longitude, brgRad, distM)
          const [dla, dlh]   = ddmm(dLat, true)
          const [dlo, dloh]  = ddmm(dLon, false)
          // Range field is `xxx.x` — clamp rather than overflow it on a long leg.
          const distStr = Math.min(distM * M_TO_NM, 999.9).toFixed(1)
          const brgStr  = deg3(brgRad)
          const vmgStr  = vmgMs != null ? (vmgMs * MS_TO_KN).toFixed(1) : ''

          const rmb = sentence(`NPRMB,${status},${xteStr},${steer},${originId},${destId},${dla},${dlh},${dlo},${dloh},${distStr},${brgStr},${vmgStr},${arrived}`)
          send(rmb)
          app.debug(rmb)
          wptSent = true
        }

        // APA — autopilot format A. Bearing field is the origin->dest track
        // bearing; prefer magnetic (unit M), fall back to true (unit T).
        if (sendAPA) {
          const trk     = trkMag != null ? trkMag : trkTrue
          const trkUnit = trkMag != null ? 'M' : 'T'
          const trkStr  = deg3(trk)
          // arrival circle + arrival perpendicular (perpendicular approximated by the circle flag).
          const apa = sentence(`NPAPA,${status},${status},${xteStr},${steer},N,${arrived},${arrived},${trkStr},${trkUnit},${destId}`)
          send(apa)
          app.debug(apa)
        }

        // XTE — cross-track error only.
        if (sendXTE && xteM != null) {
          const xte = sentence(`NPXTE,${status},${status},${xteStr},${steer},N`)
          send(xte)
          app.debug(xte)
        }
      }

      // Live status shown in the plugin list, updated each cycle. The ticks
      // report Signal K *input* availability; whether the sentences reach the
      // instrument received them is only knowable on TCP, via the link state.
      const f = (v) => v != null ? '✓' : '✗'
      const deps =
        `pos${stale ? '⚠' : '✓'} cog${f(cogRad)} sog${f(sogMs)} var${f(varRad)} ` +
        `rmc${rmcSent ? '✓' : '✗'} wpt${wptSent ? '✓' : '✗'}`

      if (stale && connected) {
        // Not an outage — the link is fine and sentences are still going out.
        // But they carry status V, so the processor is ignoring them.
        app.setPluginError(
          `Position is ${Math.round(posAgeMs / 1000)}s old (limit ${maxAgeMs / 1000}s) — ` +
          `sending status V to ${dest}, processor will discard | ${deps}`
        )
      } else if (connected) {
        app.setPluginStatus(`Active →${dest} @ ${rateHz}Hz | ${deps}`)
      } else {
        app.setPluginError(
          `No link to ${dest}${lastDrop ? ` (${lastDrop})` : ''} — ` +
          `retrying every 5s, sentences discarded | ${deps}`
        )
      }
    }

    if (isUdp) openUdp()
    else connect()
    timer = setInterval(transmit, periodMs)
    app.setPluginStatus(`Active — opening ${dest} at ${rateHz} Hz`)
  }

  plugin.stop = function () {
    stopped   = true
    connected = false
    lastDrop  = null
    if (timer)     { clearInterval(timer); timer = null }
    if (reconnect) { clearTimeout(reconnect); reconnect = null }
    if (socket)    { try { socket.close ? socket.close() : socket.destroy() } catch (e) {} socket = null }
    app.setPluginStatus('Stopped')
  }

  return plugin
}
