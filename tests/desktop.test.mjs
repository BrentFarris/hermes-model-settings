import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import vm from 'node:vm'

// Use npm-installed test dependencies, or reuse an existing Hermes development
// checkout's versions without installing anything into Hermes itself.
const require = createRequire(process.env.HERMES_DESKTOP_DIR
  ? path.join(process.env.HERMES_DESKTOP_DIR, 'package.json') : new URL('../package.json', import.meta.url))
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = require('react')
const jsxRuntime = require('react/jsx-runtime')
const { act, cleanup, fireEvent, render, waitFor } = require('@testing-library/react')
afterEach(cleanup)

function atom(initial) {
  let value = initial
  const subscribers = new Set()
  return {
    get: () => value,
    set(next) { value = next; for (const fn of subscribers) fn(next) },
    subscribe(fn) { subscribers.add(fn); fn(value); return () => subscribers.delete(fn) },
    get size() { return subscribers.size }
  }
}

function fixture() {
  const calls = []
  const values = new Map()
  const overrides = new Map()
  let epoch = 1
  const state = {
    profile: atom('default'), focusedSessionProfile: atom('default'), focusedSessionId: atom('chat-1'),
    model: atom('GLM-5.3-Flash'), gateway: atom('open')
  }
  const key = params => `${params.profile}:${params.base_url}:${params.model}`
  const api = { state, async request(method, params) {
    calls.push({ method, params: { ...params } })
    if (overrides.has(method)) return overrides.get(method)(params)
    if (method === 'runtime.describe') return { capabilities: ['plugin-rpc-v1'] }
    if (method === 'model.options') return {
      model: state.model.get(), provider: 'custom:glm-local',
      providers: [{ slug: 'custom:glm-local', is_current: true, is_user_defined: true, api_url: 'http://model.test/v1' }]
    }
    if (method.endsWith('.set')) values.set(key(params), params.temperature)
    return { supported: true, route: { provider: 'custom', model: params.model, base_url: params.base_url },
      temperature: values.get(key(params)) ?? null, default_temperature: 0 }
  } }
  return { api, calls, values, overrides, epoch: () => epoch, nextEpoch: () => { epoch++ } }
}

const PopoverContext = React.createContext(null)
const sdkUi = {
  Button: ({ variant, size, ...props }) => React.createElement('button', props),
  Input: props => React.createElement('input', props),
  Popover: ({ open, onOpenChange, children }) => React.createElement(PopoverContext.Provider,
    { value: { open, onOpenChange } }, children),
  PopoverTrigger: ({ children }) => {
    const value = React.useContext(PopoverContext)
    return React.cloneElement(children, { onClick: () => value.onOpenChange(!value.open) })
  },
  PopoverContent: ({ children }) => React.useContext(PopoverContext).open
    ? React.createElement('div', { role: 'dialog' }, children) : null
}

async function loadPlugin(f = fixture()) {
  const context = vm.createContext({ console, queueMicrotask, setTimeout, clearTimeout })
  const sdk = { ...sdkUi, host: f.api, gatewayActivationEpoch: f.epoch,
    COMPOSER_AREAS: { actions: 'composer.actions' } }
  const imports = new Map()
  for (const [name, object] of [['@hermes/plugin-sdk', sdk], ['react', React], ['react/jsx-runtime', jsxRuntime]]) {
    const names = Object.keys(object)
    imports.set(name, new vm.SyntheticModule(names, function () {
      for (const key of names) this.setExport(key, object[key])
    }, { context }))
  }
  const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const mod = new vm.SourceTextModule(source, { context })
  await mod.link(specifier => {
    assert.ok(imports.has(specifier), `unsupported disk-plugin import: ${specifier}`)
    return imports.get(specifier)
  })
  await mod.evaluate()
  return { ...f, exports: mod.namespace, controller: mod.namespace.createController(f.api, f.epoch) }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('loads defaults, saves zero, and resets the same provider/model', async () => {
  const f = await loadPlugin()
  await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().data.temperature, null)
  assert.equal(await f.controller.save(0), true)
  assert.equal(f.controller.getSnapshot().data.temperature, 0)
  assert.equal(await f.controller.save(null), true)
  assert.equal(f.controller.getSnapshot().data.temperature, null)
  const writes = f.calls.filter(call => call.method.endsWith('.set'))
  assert.deepEqual(writes.map(call => call.params.temperature), [0, null])
  assert.equal(writes[0].params.session_id, 'chat-1')
  assert.equal(writes[0].params.profile, 'default')
})

test('validates finite numbers, range, and hundredths', async () => {
  const { exports: { parseTemperature } } = await loadPlugin()
  for (const invalid of ['', ' ', 'NaN', 'Infinity', '-0.01', '2.01', '0.705']) {
    assert.throws(() => parseTemperature(invalid))
  }
  assert.equal(parseTemperature('0'), 0)
  assert.equal(parseTemperature('0.70'), 0.7)
  assert.equal(parseTemperature('2'), 2)
})

test('failed save retains the confirmed temperature and shows the error', async () => {
  const f = await loadPlugin()
  await f.controller.refresh()
  await f.controller.save(0.4)
  f.overrides.set('plugin.hermes-model-settings.settings.set', () => { throw new Error('Storage unavailable') })
  assert.equal(await f.controller.save(1.2), false)
  assert.equal(f.controller.getSnapshot().data.temperature, 0.4)
  assert.match(f.controller.getSnapshot().error, /Storage unavailable/)
  assert.equal(f.controller.getSnapshot().saving, false)
})

test('model/profile change during save cannot retarget the write or overwrite the new view', async () => {
  const f = await loadPlugin()
  await f.controller.refresh()
  const pending = deferred()
  f.overrides.set('plugin.hermes-model-settings.settings.set', () => pending.promise)
  const save = f.controller.save(0.8)
  f.api.state.model.set('Another model')
  f.api.state.focusedSessionId.set('chat-2')
  f.api.state.focusedSessionProfile.set('second-profile')
  f.api.state.profile.set('second-profile')
  await f.controller.refresh()
  pending.resolve({ supported: true, temperature: 0.8 })
  assert.equal(await save, false)
  assert.equal(f.controller.getSnapshot().model, 'Another model')
  assert.equal(f.controller.getSnapshot().data.temperature, null)
  const write = f.calls.find(call => call.method.endsWith('.set'))
  assert.equal(write.params.model, 'GLM-5.3-Flash')
  assert.equal(write.params.profile, 'default')
})

test('stale reads and same-profile gateway switches cannot publish or write', async () => {
  const f = await loadPlugin()
  const pending = deferred()
  f.overrides.set('plugin.hermes-model-settings.settings.get', () => pending.promise)
  const oldRead = f.controller.refresh()
  await waitFor(() => assert.ok(f.calls.some(call => call.method.endsWith('.get'))))
  f.nextEpoch()
  f.overrides.delete('plugin.hermes-model-settings.settings.get')
  await f.controller.refresh()
  pending.resolve({ supported: true, temperature: 1.99 })
  await oldRead
  assert.equal(f.controller.getSnapshot().data.temperature, null)
  f.nextEpoch()
  assert.equal(await f.controller.save(1), false)
  assert.equal(f.calls.filter(call => call.method.endsWith('.set')).length, 0)
})

test('duplicate commits and same-route refresh do not interrupt an in-flight save', async () => {
  const f = await loadPlugin()
  await f.controller.refresh()
  const pending = deferred()
  f.overrides.set('plugin.hermes-model-settings.settings.set', () => pending.promise)
  const first = f.controller.save(0.7)
  assert.equal(await f.controller.save(0.7), false)
  await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().saving, true)
  pending.resolve({ supported: true, temperature: 0.7 })
  assert.equal(await first, true)
  assert.equal(f.calls.filter(call => call.method.endsWith('.set')).length, 1)
})

test('disconnected, incompatible, unsupported, and disabled backend states are actionable', async () => {
  const f = await loadPlugin()
  f.api.state.gateway.set('connecting')
  await f.controller.refresh()
  assert.match(f.controller.getSnapshot().error, /Connect/)
  assert.equal(f.calls.length, 0)
  f.api.state.gateway.set('open')
  f.overrides.set('runtime.describe', () => ({ capabilities: [] }))
  await f.controller.refresh()
  assert.match(f.controller.getSnapshot().error, /0.23.1/)
  f.overrides.delete('runtime.describe')
  f.overrides.set('model.options', () => ({ model: 'Builtin', providers: [] }))
  await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().data.supported, false)
  f.overrides.delete('model.options')
  f.overrides.set('plugin.hermes-model-settings.settings.get', () => { throw new Error('-32601 method not found') })
  await f.controller.refresh()
  assert.match(f.controller.getSnapshot().error, /Enable.*backend/)
})

test('fresh drafts never write another model default under a mismatched label', async () => {
  const f = await loadPlugin()
  f.api.state.focusedSessionId.set(null)
  f.overrides.set('model.options', () => ({ model: 'Other default', provider: 'custom:glm-local',
    providers: [{ is_current: true, api_url: 'http://model.test/v1' }] }))
  await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().data.supported, false)
  assert.equal(await f.controller.save(0.7), false)
})

test('runtime describe has no params and ambiguous or foreign chat owners cannot write', async () => {
  const f = await loadPlugin()
  await f.controller.refresh()
  assert.deepEqual(f.calls.find(call => call.method === 'runtime.describe').params, {})
  f.api.state.connectionId = atom('local')
  f.api.state.focusedSessionOwner = atom({ connectionId: 'remote', profile: 'default' })
  await f.controller.refresh()
  assert.match(f.controller.getSnapshot().error, /Switch.*gateway/)
  assert.equal(await f.controller.save(0.7), false)
  f.api.state.focusedSessionOwner.set(null)
  await f.controller.refresh()
  assert.match(f.controller.getSnapshot().error, /owner/)
  f.api.state.focusedSessionOwner.set({ connectionId: 'local', profile: 'default' })
  await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().data.supported, true)
})

test('slider and number input stay synchronized, commit once, reject invalid input, and reset', async () => {
  const f = await loadPlugin()
  await f.controller.refresh()
  const view = render(React.createElement(f.exports.TemperatureControl, { controller: f.controller }))
  fireEvent.click(view.getByRole('button', { name: /Model temperature/ }))
  await waitFor(() => assert.equal(view.getByRole('spinbutton').disabled, false))
  const slider = view.getByRole('slider')
  const number = view.getByRole('spinbutton')
  fireEvent.change(slider, { target: { value: '0.73' } })
  assert.equal(number.value, '0.73')
  assert.equal(f.calls.filter(call => call.method.endsWith('.set')).length, 0)
  fireEvent.pointerUp(slider)
  await waitFor(() => assert.equal(f.controller.getSnapshot().data.temperature, 0.73))
  fireEvent.change(number, { target: { value: '1.25' } })
  assert.equal(slider.value, '1.25')
  fireEvent.keyDown(number, { key: 'Enter' })
  fireEvent.blur(number)
  await waitFor(() => assert.equal(f.controller.getSnapshot().data.temperature, 1.25))
  assert.equal(f.calls.filter(call => call.method.endsWith('.set')).length, 2)
  fireEvent.change(number, { target: { value: '2.5' } })
  fireEvent.blur(number)
  assert.match(view.getByRole('alert').textContent, /between 0 and 2/)
  assert.equal(f.calls.filter(call => call.method.endsWith('.set')).length, 2)
  fireEvent.click(view.getByRole('button', { name: 'Use model default' }))
  await waitFor(() => assert.equal(f.controller.getSnapshot().data.temperature, null))
  assert.match(view.getByRole('button', { name: /Model temperature/ }).textContent, /Default/)
})

test('keyboard slider commit and failed save display the confirmed value', async () => {
  const f = await loadPlugin()
  await f.controller.refresh()
  const view = render(React.createElement(f.exports.TemperatureControl, { controller: f.controller }))
  fireEvent.click(view.getByRole('button', { name: /Model temperature/ }))
  await waitFor(() => assert.equal(view.getByRole('slider').disabled, false))
  fireEvent.change(view.getByRole('slider'), { target: { value: '0.4' } })
  fireEvent.keyUp(view.getByRole('slider'), { key: 'ArrowRight' })
  await waitFor(() => assert.equal(f.controller.getSnapshot().data.temperature, 0.4))
  f.overrides.set('plugin.hermes-model-settings.settings.set', () => { throw new Error('Write failed') })
  fireEvent.change(view.getByRole('spinbutton'), { target: { value: '0.9' } })
  fireEvent.keyDown(view.getByRole('spinbutton'), { key: 'Enter' })
  await waitFor(() => assert.match(view.getByRole('alert').textContent, /Write failed/))
  assert.match(view.getByRole('button', { name: /Model temperature/ }).textContent, /0.40/)
  assert.equal(view.getByRole('spinbutton').value, '0.9')
})

test('registration and disposal remove subscriptions and ignore late completions', async () => {
  const f = await loadPlugin()
  const disposers = []
  const events = new Map()
  const intervals = []
  const contributions = []
  const ctx = {
    register: value => contributions.push(value), onDispose: fn => disposers.push(fn),
    onEvent: (name, fn) => events.set(name, fn), setInterval: fn => intervals.push(fn)
  }
  f.exports.default.register(ctx)
  await waitFor(() => assert.ok(f.calls.some(call => call.method.endsWith('.get'))))
  assert.equal(contributions[0].area, 'composer.actions')
  assert.equal(f.api.state.model.size, 1)
  f.nextEpoch()
  await act(async () => { intervals[0]() })
  for (const dispose of disposers) dispose()
  assert.equal(f.api.state.model.size, 0)
  const count = f.calls.length
  f.api.state.model.set('other')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(f.calls.length, count)
  const pending = deferred()
  f.overrides.set('plugin.hermes-model-settings.settings.get', () => pending.promise)
  const loading = f.controller.refresh()
  await new Promise(resolve => setTimeout(resolve, 0))
  const old = f.controller.getSnapshot()
  f.controller.dispose()
  pending.resolve({ supported: true, temperature: 2 })
  await loading
  assert.equal(f.controller.getSnapshot(), old)
})
