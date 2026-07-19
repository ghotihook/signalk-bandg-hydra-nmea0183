# Changelog

## 0.1.0

First release. Feeds RMC, RMB, APA and XTE to a B&G H2000 processor over TCP or UDP,
in the legacy format the Hydra 2000 manual specifies.

Not yet tested against H2000 hardware — the sentence structure is verified against the
manual, but no processor has confirmed it parses them. Verify the RMB/APA steer direction
against your autopilot before relying on it to navigate.
