# signalk-bandg-hydra-nmea0183

Signal K plugin. See signalk-gps-position-of-bow / signalk-stw-heel-correction for full working references.

---

## Plugin structure

```js
module.exports = function (app) {
  const plugin = {
    id: 'signalk-bandg-hydra-nmea0183',
    name: '...',
    description: '...'
  }

  plugin.schema = { ... }   // config fields
  plugin.uiSchema = { ... } // optional UI hints (e.g. textarea for large fields)

  plugin.start = function (options) {
    // read options, register handlers, set status
    app.setPluginStatus('Active — ...')
  }

  plugin.stop = function () {
    app.setPluginStatus('Stopped')
  }

  return plugin
}
```

---

## Reading Signal K data

**Composite paths** (like `navigation.attitude`) are stored as an object — access sub-fields via `.value.roll` etc:
```js
const attitudeData = app.getSelfPath('navigation.attitude')
const roll = attitudeData?.value?.roll  // NOT app.getSelfPath('navigation.attitude.roll')
```

**Scalar paths** work as expected:
```js
const sog = app.getSelfPath('navigation.speedOverGround')?.value
```

---

## Emitting a corrected/derived value

```js
app.handleMessage(plugin.id, {
  context: 'vessels.' + app.selfId,
  updates: [{
    source: { label: plugin.id, type: 'plugin' },
    timestamp: new Date().toISOString(),
    values: [{ path: 'navigation.some.path', value: result }]
  }]
})
```

---

## Delta input handler — key gotchas

### Self-source check: use `label`, not `$source`
When your emitted delta comes back through `registerDeltaInputHandler`, `$source` is not yet set on `update.source`. Check `label` instead:

```js
if (update.source && update.source.label === plugin.id) {
  next(delta)
  return
}
```

Using `$source` here will silently fail and cause infinite recursion (stack overflow).

### Stripping a path from the raw delta
If you want only your corrected value in the delta stream (so downstream apps don't see duplicates), filter it out of the raw delta before calling `next()`:

```js
for (const update of (delta.updates || [])) {
  update.values = (update.values || []).filter(v => v.path !== 'the.path.you.corrected')
}
next(delta)
```

This lets other values in the same delta (e.g. `ReferenceType` fields) pass through unchanged.

---

## Logging

```js
app.debug('...')           // visible when debug enabled for this plugin
app.setPluginStatus('...') // shown in admin UI plugin list
app.setPluginError('...')  // shown as error in admin UI
```

---

## Source priorities and delta stream

- Signal K stores **all sources** for a path. Priority only controls which value wins when the data model is queried (REST, WebSocket path subscriptions).
- Apps subscribing to the **raw delta stream** see every source's updates — they do not receive priority information. If you want such apps to see only one value, strip the raw value from the delta (see above).

---

## Deployment workflow

```bash
# Mac
git push

# Server
git -C ~/signalk-bandg-hydra-nmea0183 pull && sudo systemctl restart signalk
```

Install once on server:
```bash
cd ~/.signalk && npm install file:/home/alex060/signalk-bandg-hydra-nmea0183
sudo systemctl restart signalk
```

---

## package.json minimum

```json
{
  "name": "signalk-bandg-hydra-nmea0183",
  "version": "0.1.0",
  "description": "...",
  "main": "index.js",
  "keywords": ["signalk-node-server-plugin"],
  "license": "Apache-2.0",
  "engines": { "node": ">=12" }
}
```
