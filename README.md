# signalk-bandg-hydra-nmea0183

[![CI](https://github.com/ghotihook/signalk-bandg-hydra-nmea0183/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/ghotihook/signalk-bandg-hydra-nmea0183/actions/workflows/signalk-ci.yml)

Sends GPS position and waypoint navigation from Signal K to an older B&G processor — the H2000
series (Hydra, Hercules) and similar hardware of that era.

**Who it's for.** You have a modern GPS or chartplotter feeding Signal K, and an old B&G
processor that won't accept its NMEA 0183 output.

**What it does.** Emits RMC, RMB, APA and XTE in the outdated format those processors actually
parse. They predate the current standard and ignore compliant sentences, so this plugin
deliberately produces the older form.

**If your kit accepts modern NMEA 0183**, use
[signalk-to-nmea0183](https://github.com/SignalK/signalk-to-nmea0183) instead. Reach for this one
when that output is *too* correct and the processor won't take it.

## Quick start

1. **Install** from the Signal K App Store, then enable it in **Server → Plugin Config**.
   (Needs Node 20.10 or later.)
2. **Set up a bridge.** The plugin sends over the network; the processor's NMEA input is serial.
   Something has to convert between them — see [Wiring](#wiring-you-need-a-bridge).
3. **Point the plugin at your bridge** — set the destination address and port. Leave everything
   else alone to start with.
4. **Check the status line** in the plugin list. It should read `Active →tcp …` with a row of
   ticks.

That's the whole setup. The defaults suit a standard 4800-baud connection, and no Signal K Data
Connection is needed — the plugin manages its own socket.

---

## Wiring: you need a bridge

**This plugin puts sentences on the network. The processor has a serial NMEA 0183 input.**
Something has to sit between the two — the H2000 has no idea what an IP packet is.

```
Signal K ──── TCP/UDP ────▶ bridge ──── serial NMEA 0183 ────▶ H2000 NMEA input
```

Two common ways to build that bridge:

- **A serial device server** — Moxa NPort, USR-TCP232, Digi One and similar. Configure it to
  listen on the address and port you set in the plugin, and wire its serial output to the
  processor's NMEA input.
- **socat on any Linux box** with a USB-to-serial adapter:

  ```bash
  socat TCP-LISTEN:1183,reuseaddr,fork /dev/ttyUSB0,b4800,raw
  ```

Check your processor's manual for the input's electrical standard — RS-422 differential is usual
on kit of this era, and polarity matters — and for its baud rate. Standard NMEA 0183 is 4800.

### The transmit rate has to fit the wire

4800 baud carries about 480 characters per second. A full RMC + RMB + APA + XTE cycle is roughly
183 characters, so:

| Rate | Link used |
|------|-----------|
| 1 Hz | 38% |
| 2 Hz | 76% |
| 2.5 Hz | 95% |
| 4 Hz | **153% — sentences will be dropped or corrupted** |

**1 Hz is the sensible default and 2 Hz is the practical ceiling** on a 4800-baud link. The
plugin will let you set up to 10 Hz, which is useful over a fast bridge but will overrun a
standard serial connection. If the processor starts showing intermittent or frozen data, the
transmit rate is the first thing to reduce.

---

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| Transport | `TCP` | `TCP` opens a client connection to the destination; `UDP` sends datagrams |
| Destination address | `192.168.0.2` | Host to send to. For UDP this may be a broadcast address |
| Destination port | `1183` | Destination port |
| TCP connect timeout (s) | `5` | TCP only. Stops a destination that silently drops packets from stalling for the OS timeout (~2 min) before retrying |
| Transmit rate (Hz) | `1` | How often sentences are sent |
| Maximum position age (s) | `5` | Past this age the fix is treated as stale and nothing is sent at all. `0` disables the check |
| Destination waypoint label | `WPT` | Fills the 4-character waypoint identifier field in RMB and APA. Clear it to leave the field empty |
| Send RMC | `true` | Position, SOG, COG, date, variation |
| Send RMB | `true` | Active waypoint navigation |
| Send APA | `true` | Autopilot format A |
| Send XTE | `true` | Cross-track error |
| Arrival radius (m) | `100` | Distance at which RMB/APA report arrival (the v2 arrival circle isn't in the v1 data model, so it's set here) |

### TCP or UDP?

| | TCP | UDP |
|---|-----|-----|
| Connection | Client connection out to the instrument | Connectionless datagrams |
| Delivery | Retried and reported; status line shows link state | Fire-and-forget, unconfirmed |
| Reconnects | Automatically, every 5 s | N/A |
| Broadcast | No | Yes — e.g. `192.168.0.255` |

Prefer **TCP** when the bridge accepts a connection: you get real delivery feedback and the
status line tells you when the link is down. Use **UDP** for devices that only listen, or to
reach several at once by broadcast — accepting that nothing will tell you if data isn't
arriving.

Because the plugin writes to its own socket, these sentences reach only the destination you
configure. They never enter the server's shared NMEA 0183 output (port 10110), so nothing else
on the boat sees them.

### Reading the status

The status line updates every cycle, leading with the link state:

```
Active →tcp 192.168.0.2:1183 @ 1Hz | pos✓ cog✗ sog✓ var✓ rmc✓ wpt✓
```

If the destination can't be reached it turns red, carries the reason, and keeps retrying:

```
No link to tcp 192.168.0.2:1183 (error: connect ECONNREFUSED) — retrying every 5s, sentences discarded
```

`ECONNREFUSED` means the host is up but nothing is listening on that port; `connect timeout`
means the host isn't answering at all. The `pos/cog/sog/var` ticks report Signal K **input**
availability — they say nothing about the link, so read the link state first.

**On UDP there is no link state.** The status shows `Active →udp …` whenever the socket is
open, which it essentially always is. UDP cannot tell you whether anything received the data;
use TCP if you need to know the processor is really being fed.

Enable debug logging in the admin UI to see each sentence as it goes out:

```
$NPRMC,071142,A,3352.08,S,15114.03,E,6.1,045,160626,12,E*5F
$NPRMB,A,0.02,L,,WPT,3352.00,S,15113.00,E,1.2,048,5.9,V*6E
$NPAPA,A,A,0.02,L,N,V,V,048,M,WPT*72
$NPXTE,A,A,0.02,L,N*65
```

---

## Sentences

| Sentence | Contents | Sent when |
|----------|----------|-----------|
| **RMC** | Position, UTC time and date, SOG, COG, magnetic variation | Always (can be disabled) |
| **RMB** | Active waypoint navigation — XTE, range, bearing, VMG | A destination is set |
| **APA** | Autopilot format A — XTE, steer direction, arrival flags, track bearing | A course is active |
| **XTE** | Cross-track error and steer direction | A course is active |

RMC already carries SOG and COG, so VTG is not sent. Each sentence can be turned off
individually.

### What this sends, against current NMEA 0183

The standard has grown fields since the H2000 was built. Each sentence below shows what this
plugin sends, then the current form, with the added fields marked.

#### RMC — recommended minimum navigation data

```
we send   $NPRMC,221820,A,3352.08,S,15112.54,E,6.2,045,190726,12,E*5C
current   $GPRMC,221820.00,A,3352.0800,S,15112.5400,E,6.2,45.2,190726,12.3,E,A,S*hh
                                                                            ─┬─ ─┬─
                                                                             1   2
```

11 fields sent, 13 in the current standard:

| # | Added field | Values | Added in |
|---|-------------|--------|----------|
| 1 | Mode indicator | `A` autonomous, `D` differential, `E` estimated, `N` invalid | v2.3 |
| 2 | Navigational status | `S` safe, `C` caution, `U` unsafe, `V` not valid | v4.1 |

#### RMB — navigation to a waypoint

```
we send   $NPRMB,A,0.02,L,,WPT,3352.00,S,15113.00,E,1.2,048,5.9,V*6E
current   $GPRMB,A,0.02,L,,WPT,3352.0000,S,15113.0000,E,1.2,48.0,5.9,V,A*hh
                                                                      ─┬─
                                                                       1
```

13 fields sent, 14 in the current standard:

| # | Added field | Values | Added in |
|---|-------------|--------|----------|
| 1 | Mode indicator | `A` / `D` / `E` / `N` | v2.3 |

#### APA vs APB — autopilot

This is the big one. APA was superseded by APB, which carries five more fields:

```
we send   $NPAPA,A,A,0.02,L,N,V,V,048,M,WPT*72
current   $GPAPB,A,A,0.02,L,N,V,V,048,M,WPT,050,M,052,M,A*hh
                                            ─┬─ ┬ ─┬─ ┬ ┬
                                             1  2  3  4 5
```

10 fields sent, 15 in APB:

| # | Added field | Meaning |
|---|-------------|---------|
| 1–2 | Bearing to destination, and its unit | Bearing from *present position* to the waypoint — APA only carries origin-to-destination |
| 3–4 | Heading to steer, and its unit | The course the pilot should steer to close the track |
| 5 | Mode indicator | `A` / `D` / `E` / `N`, added v2.3 |

APA gives the pilot the track bearing and the cross-track error and leaves it to work out the
correction itself. APB hands it the answer. Pilots of this era expect APA.

#### XTE — cross-track error

```
we send   $NPXTE,A,A,0.02,L,N*65
current   $GPXTE,A,A,0.02,L,N,A*hh
                             ─┬─
                              1
```

5 fields sent, 6 in the current standard:

| # | Added field | Values | Added in |
|---|-------------|--------|----------|
| 1 | Mode indicator | `A` / `D` / `E` / `N` | v2.3 |

### Field formatting differences

Beyond the extra fields, the values themselves are written differently:

| | This plugin | Current standard | Why |
|---|---|---|---|
| Talker ID | `NP` | `GP`/`GN`, `II`, `EC` | The manual's diagrams show a wildcard device identifier, so the processor doesn't filter on it |
| Latitude / longitude | `ddmm.mm` (~18 m) | `ddmm.mmmm` (~1.8 m) | The manual specifies 2 decimal minutes |
| COG and bearings | `045` | `45.2` | The manual's `xxx` fields have no decimal place |
| Magnetic variation | `12` | `12.3` | The manual's `xx` field |
| Time | `221820` | `221820.00` | No fractional seconds in the manual |

Decimal numeric fields are **not** zero-padded — `6.1`, not `06.1`. The manual writes SOG as
`xx.x`, which looks like a fixed width, but the processor accepts the natural form. Only
coordinates and bearings are padded to a fixed width.

Every difference above is a deliberate downgrade. A parser from this era reads fields by
position and stops at the count it expects, so a trailing mode indicator can be enough to make
the whole sentence unusable.

---

## How it works

1. On a timer at the configured rate, the latest `navigation.position` is read from the Signal K data model.
2. `RMC` is built (decimal degrees → `ddmm.mm` + hemisphere) with UTC time and date, plus SOG, COG and magnetic variation when available. The RMC COG field is true-referenced; if `navigation.courseOverGroundTrue` is absent it is derived from `navigation.courseOverGroundMagnetic` + `navigation.magneticVariation`.
3. If a course is active, the enabled course sentences are built from `navigation.course.calcValues.*`: `RMB` (cross-track error, distance, bearing, VMG — the waypoint position is recovered from vessel position + bearing + distance via great-circle forward), `APA` (XTE, steer, arrival flags, track bearing) and `XTE`.
4. Each checksummed, CRLF-terminated sentence is written to the TCP connection or sent as a UDP datagram.

The output format follows the legacy `legacy_gps.py` processor.

---

## Notes and known limitations

**Not yet tested against H2000 hardware.** The sentence structure is verified against the Hydra
2000 manual and covered by tests, but no processor has confirmed it parses them.

**Check the steer direction against your pilot.** The RMB and APA steer direction (L/R) follows
the Signal K convention that a negative `crossTrackError` puts the vessel left of track — so
positive means steer left. That matches the spec, but confirm it against live data before
trusting it to steer: it's a one-line sign flip in `index.js` if your pilot disagrees.

**Course data comes from the v1 model.** `app.getSelfPath` reads the **v1** data model, where
`navigation.course` exposes only `calcValues.*` — the v2 Course API's `nextPoint`,
`previousPoint` and `arrivalCircle` are not visible there. So an active course is detected via
`calcValues.distance`, the waypoint lat/lon is derived rather than read directly, and the
arrival radius is a plugin option instead of being taken from the arrival circle.

**Precision is deliberately coarse, in two places.** Lat/lon are emitted as `ddmm.mm` (2 decimal
minutes, ~18 m) and bearings as bare integer degrees (`045`, not `45.2`) — both to match the
field widths in the Hydra 2000 manual exactly. The manual gives COG, RMB bearing, APA track and
magnetic variation no decimal place at all, so 1° is the available resolution for those. *To
revisit:* if your instrument accepts extended precision, `ddmm()` and `deg3()` in `index.js` are
the two places to widen.

**A stale position stops transmission.** Signal K serves the last known `navigation.position`
indefinitely — if the GPS loses lock or its source dies, the data model keeps returning a frozen
fix with nothing to mark it old, and the processor would navigate on it. So the position's
timestamp is checked each cycle, and once it exceeds *Maximum position age* nothing is sent at
all — exactly as if there were no fix. The status line turns red and reports the age.
Transmission resumes by itself when the position updates again.

Sources that publish no timestamp can't be judged and are treated as current. Set *Maximum
position age* to `0` to disable the check entirely.

---

## Roadmap

**Emit through Signal K's own NMEA 0183 output rather than a private socket.** The server has
output plumbing for this: a plugin calls `app.emit('nmea0183out', sentence)` and the sentence
flows to whatever outputs the user has configured, instead of to a socket the plugin opened
itself.

The gain is that the sentences could then be routed through any **pre-configured Data
Connection** — including a serial port wired straight to the processor. For anyone whose Signal
K machine is already physically connected to the H2000, that removes the bridge entirely, along
with this plugin's socket handling, reconnect logic and link reporting.

Two things to solve before that swap is worth making. The admin UI only exposes a TCP output for
Data Connections, and the server applies validation to that output which has to be disabled by
hand — awkward for sentences that are intentionally non-compliant, which is the whole point
here. The shared output on port 10110 would also carry these sentences to everything else on the
boat, where today they reach only the configured destination.

Likely shape: keep the private socket as one transport option and add `nmea0183out` as another,
rather than replacing one with the other.

---

## Development

```bash
git clone https://github.com/ghotihook/signalk-bandg-hydra-nmea0183 ~/signalk-bandg-hydra-nmea0183
cd ~/.signalk && npm install ~/signalk-bandg-hydra-nmea0183
sudo systemctl restart signalk

# after changes
git -C ~/signalk-bandg-hydra-nmea0183 pull && sudo systemctl restart signalk
```

### Tests

```bash
npm test
```

No dependencies — the suite runs on the built-in Node test runner. It covers the field
formatting (where every bug found so far has been) and drives the plugin end to end against a
throwaway TCP listener, checking the emitted sentences against the field diagrams in the Hydra
2000 manual.

---

## License

Apache-2.0
