# Changelog

## Unreleased

- A stale position now stops transmission entirely rather than being sent flagged
  invalid. Past *Maximum position age* nothing goes out at all, as if there were no
  fix; transmission resumes when the position updates.
- *Maximum position age* default lowered from 10 s to 5 s.
- README restructured to lead with what the plugin is and a quick start, with
  reference detail following.
- Documented that a bridge is required between the plugin's TCP/UDP output and the
  processor's serial NMEA input, and the transmit rate a 4800-baud link can carry.
- Replaced the sentence-by-sentence comparison against current NMEA 0183 with a worked example
  of each sentence sent, annotated field by field.
- Corrected the roadmap section on emitting to a Data Connection. Serial and gpsd outputs are
  supported as well as TCP, so the bridge-free serial path is open; UDP has no output-event
  support at all; and the claim that the server validates these outputs was wrong — there is no
  such validation in any of the write paths.

## 0.1.0

First release. Feeds RMC, RMB, APA and XTE to a B&G H2000 processor over TCP or UDP,
in the legacy format the Hydra 2000 manual specifies.

Not yet tested against H2000 hardware — the sentence structure is verified against the
manual, but no processor has confirmed it parses them. Verify the RMB/APA steer direction
against your autopilot before relying on it to navigate.
