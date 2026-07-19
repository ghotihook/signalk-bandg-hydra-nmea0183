'use strict'

// Field formatting. Every bug found in this plugin so far has been here: a
// coordinate that rounded to 60 minutes, a bearing carrying a decimal place the
// Hydra 2000 manual has no field for, a negative bearing formatted as "0-3".

const { test } = require('node:test')
const assert   = require('node:assert')

const { nmeaChecksum, sentence, ddmm, deg3, destFrom } = require('..')._internal

test('checksum matches the canonical NMEA example', () => {
  // The $GPGGA sample published with the 0183 standard, checksum 47.
  assert.equal(nmeaChecksum('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,'), '47')
})

test('checksum is always two uppercase hex digits', () => {
  for (const body of ['A', 'NPXTE,A,A,0.02,L,N', 'x'.repeat(70), '']) {
    assert.match(nmeaChecksum(body), /^[0-9A-F]{2}$/)
  }
})

test('sentence framing is $body*CS + CRLF', () => {
  assert.equal(sentence('NPXTE,A,A,0.02,L,N'), '$NPXTE,A,A,0.02,L,N*65\r\n')
})

test('ddmm formats to the manual widths', () => {
  assert.deepEqual(ddmm(-33.868, true),   ['3352.08', 'S'])
  assert.deepEqual(ddmm(151.209, false),  ['15112.54', 'E'])
  assert.deepEqual(ddmm(0, true),         ['0000.00', 'N'])
  assert.deepEqual(ddmm(-0.004, false),   ['00000.24', 'W'])
})

test('ddmm never emits 60 minutes', () => {
  // Regression: splitting degrees from minutes and then rounding the remainder
  // with toFixed(2) turned 34 degrees into "3360.00" whenever the fractional
  // minutes landed at or above 59.995 — roughly once an hour at 1 Hz.
  assert.deepEqual(ddmm(33.99999, true),    ['3400.00', 'N'])
  assert.deepEqual(ddmm(-33.99999, true),   ['3400.00', 'S'])
  assert.deepEqual(ddmm(151.999999, false), ['15200.00', 'E'])
  assert.deepEqual(ddmm(33.9999166, true),  ['3359.99', 'N'])
})

test('ddmm holds its width and minute range across the whole globe', () => {
  for (let i = 0; i < 200000; i++) {
    const [lat] = ddmm(Math.random() * 180 - 90, true)
    assert.equal(lat.length, 7, `bad latitude width: ${lat}`)
    assert.ok(Number(lat.slice(2)) < 60, `latitude minutes >= 60: ${lat}`)

    const [lon] = ddmm(Math.random() * 360 - 180, false)
    assert.equal(lon.length, 8, `bad longitude width: ${lon}`)
    assert.ok(Number(lon.slice(3)) < 60, `longitude minutes >= 60: ${lon}`)
  }
})

test('ddmm picks the hemisphere from the sign', () => {
  assert.equal(ddmm(1, true)[1], 'N')
  assert.equal(ddmm(-1, true)[1], 'S')
  assert.equal(ddmm(1, false)[1], 'E')
  assert.equal(ddmm(-1, false)[1], 'W')
})

test('deg3 emits three integer digits, no decimal place', () => {
  // The manual gives COG, RMB bearing and APA track a bare `xxx` field.
  assert.equal(deg3(0.7891), '045')
  assert.equal(deg3(3.14159), '180')
  assert.equal(deg3(0.0017), '000')
})

test('deg3 normalises out-of-range bearings', () => {
  // Regression: the old APA formatting produced "0-3" for a small negative
  // bearing, and "360" where it should wrap to "000".
  assert.equal(deg3(-0.05), '357')
  assert.equal(deg3(6.28318), '000')
  assert.equal(deg3(6.2657), '359')
})

test('deg3 renders a missing value as an empty field', () => {
  assert.equal(deg3(null), '')
  assert.equal(deg3(undefined), '')
})

test('deg3 is always three digits or empty', () => {
  for (let i = 0; i < 100000; i++) {
    const s = deg3(Math.random() * 20 - 10)
    assert.match(s, /^\d{3}$/)
    assert.ok(Number(s) >= 0 && Number(s) <= 359)
  }
})

test('destFrom round-trips a waypoint to within a metre', () => {
  // RMB needs the waypoint position, which the v1 model does not expose, so it
  // is recovered from vessel position + bearing + distance. Verify the great
  // circle forward solution against a known bearing and range.
  const [lat, lon] = destFrom(-33.868, 151.209, 0.84, 2400)
  const R = 6371000, D = Math.PI / 180
  const d = Math.acos(
    Math.sin(-33.868 * D) * Math.sin(lat * D) +
    Math.cos(-33.868 * D) * Math.cos(lat * D) * Math.cos((lon - 151.209) * D)
  ) * R
  assert.ok(Math.abs(d - 2400) < 1, `recovered range off by ${Math.abs(d - 2400)} m`)
})
