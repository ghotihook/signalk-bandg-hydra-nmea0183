# signalk-bandg-hydra-nmea0183

Signal K plugin that feeds position and navigation data into the **NMEA 0183 input** of older
B&G processors — the H2000 series (Hydra, Hercules) and similar hardware of that era — over TCP
or UDP.

These processors accept NMEA 0183 input, but only an outdated form of it. They predate the
current standard and reject or ignore sentences from a modern, compliant generator. This plugin
produces what they actually parse: `ddmm.mm` coordinates (2 decimal minutes, as the H2000
manual specifies) with the `NP` talker ID. The non-compliance is the point — it is what makes
the data usable to the processor.

So: if your kit accepts modern NMEA 0183, you want
[signalk-to-nmea0183](https://github.com/SignalK/signalk-to-nmea0183) instead. Use this one when
that output is *too* correct and the processor won't take it.

## Sentences

| Sentence | Contents | Sent when |
|----------|----------|-----------|
| **RMC** | Position, UTC time and date, SOG, COG, magnetic variation | Always (can be disabled) |
| **RMB** | Active waypoint navigation — XTE, range, bearing, VMG | A destination is set |
| **APA** | Autopilot format A — XTE, steer direction, arrival flags, track bearing | A course is active |
| **XTE** | Cross-track error and steer direction | A course is active |

RMC already carries SOG and COG, so VTG is not sent. Each sentence can be turned off
individually.

---

## Installation

Install from the Signal K **App Store** in the admin UI, then enable it in
**Server → Plugin Config**.

Or from the command line:

```bash
cd ~/.signalk
npm install signalk-bandg-hydra-nmea0183
sudo systemctl restart signalk
```

Requires Node 18 or later.

---

## Setup

Everything is configured in the plugin itself — set the transport, destination address and
port, enable it, and it starts sending. No Data Connection is required.

The plugin manages its own socket deliberately. Routing the sentences through a Signal K Data
Connection was tried and abandoned: the admin UI only exposes a TCP output for it, and it
applies validation that has to be disabled by hand — awkward for sentences that are
intentionally non-compliant, which is the entire point here.

### TCP or UDP?

| | TCP | UDP |
|---|-----|-----|
| Connection | Client connection out to the instrument | Connectionless datagrams |
| Delivery | Retried and reported; status line shows link state | Fire-and-forget, unconfirmed |
| Reconnects | Automatically, every 5 s | N/A |
| Broadcast | No | Yes — e.g. `192.168.0.255` |

Prefer **TCP** when the instrument accepts a connection: you get real delivery feedback and the
status line tells you when the link is down. Use **UDP** for devices that only listen, or to
reach several at once by broadcast — accepting that nothing will tell you if data isn't
arriving.

Because the plugin writes to its own socket, these sentences reach only the destination you
configure. They never enter the server's shared NMEA 0183 output (port 10110), so nothing else
on the boat sees them.

---

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| Transport | `TCP` | `TCP` opens a client connection to the destination; `UDP` sends datagrams |
| Destination address | `192.168.0.2` | Host to send to. For UDP this may be a broadcast address |
| Destination port | `1183` | Destination port |
| TCP connect timeout (s) | `5` | TCP only. Stops a destination that silently drops packets from stalling for the OS timeout (~2 min) before retrying |
| Transmit rate (Hz) | `1` | How often sentences are sent |
| Send RMC | `true` | Position, SOG, COG, date, variation |
| Send RMB | `true` | Active waypoint navigation |
| Send APA | `true` | Autopilot format A |
| Send XTE | `true` | Cross-track error |
| Arrival radius (m) | `100` | Distance at which RMB/APA report arrival (the v2 arrival circle isn't in the v1 data model, so it's set here) |

The plugin maintains one outbound connection and reconnects every 5 s if it drops or the
destination is unavailable.

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
use TCP if you need to know the instrument is really being fed.

Enable debug logging in the admin UI to see each sentence as it goes out:

```
$NPRMC,071142,A,3352.08,S,15114.03,E,6.1,45.2,160626,12.3,E*XX
$NPRMB,A,0.02,L,,,3352.00,S,15113.00,E,1.2,48.0,5.9,V*XX
$NPAPA,A,A,0.02,L,N,V,V,048,M,*XX
$NPXTE,A,A,0.02,L,N*XX
```

---

## How it works

1. On a timer at the configured rate, the latest `navigation.position` is read from the Signal K data model.
2. `RMC` is built (decimal degrees → `ddmm.mm` + hemisphere) with UTC time and date, plus SOG, COG and magnetic variation when available. The RMC COG field is true-referenced; if `navigation.courseOverGroundTrue` is absent it is derived from `navigation.courseOverGroundMagnetic` + `navigation.magneticVariation`.
3. If a course is active, the enabled course sentences are built from `navigation.course.calcValues.*`: `RMB` (cross-track error, distance, bearing, VMG — the waypoint position is recovered from vessel position + bearing + distance via great-circle forward), `APA` (XTE, steer, arrival flags, track bearing) and `XTE`.
4. Each checksummed, CRLF-terminated sentence is written to the TCP connection or sent as a UDP datagram.

The output format follows the legacy `legacy_gps.py` processor.

---

## Notes and known limitations

**Course data comes from the v1 model.** `app.getSelfPath` reads the **v1** data model, where
`navigation.course` exposes only `calcValues.*` — the v2 Course API's `nextPoint`,
`previousPoint` and `arrivalCircle` are not visible there. So an active course is detected via
`calcValues.distance`, the waypoint lat/lon is derived rather than read directly, and the
arrival radius is a plugin option instead of being taken from the arrival circle.

**Coordinate precision is deliberately coarse.** Lat/lon are emitted as `ddmm.mm` (2 decimal
minutes, ~18 m) to match the Hydra 2000 manual exactly, rather than the `ddmm.mmmm` that would
be possible. *To revisit:* if your instrument accepts extended precision, `ddmm()` in
`index.js` can go back to 4 decimal places for better resolution.

**Check the steer direction against your pilot.** The RMB and APA steer direction (L/R) is
derived from the sign of `crossTrackError`. Confirm against live data that it matches what your
autopilot expects — it's a one-line sign flip in `index.js` if not.

---

## Development

```bash
git clone https://github.com/ghotihook/signalk-bandg-hydra-nmea0183 ~/signalk-bandg-hydra-nmea0183
cd ~/.signalk && npm install ~/signalk-bandg-hydra-nmea0183
sudo systemctl restart signalk

# after changes
git -C ~/signalk-bandg-hydra-nmea0183 pull && sudo systemctl restart signalk
```

---

## License

Apache-2.0
