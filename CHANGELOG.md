# Changelog

## Unreleased

- A stale position now stops transmission entirely rather than being sent flagged
  invalid. Past *Maximum position age* nothing goes out at all, as if there were no
  fix; transmission resumes when the position updates.
- README restructured to lead with what the plugin is and a quick start, with
  reference detail following.
- Documented that a bridge is required between the plugin's TCP/UDP output and the
  processor's serial NMEA input, and the transmit rate a 4800-baud link can carry.
- Documented what is sent against current NMEA 0183, field by field.

## 0.1.0

First release. Feeds RMC, RMB, APA and XTE to a B&G H2000 processor over TCP or UDP,
in the legacy format the Hydra 2000 manual specifies.

Not yet tested against H2000 hardware — the sentence structure is verified against the
manual, but no processor has confirmed it parses them. Verify the RMB/APA steer direction
against your autopilot before relying on it to navigate.
