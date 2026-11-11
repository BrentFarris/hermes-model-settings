import {
  Button, COMPOSER_AREAS, Input, Popover, PopoverContent, PopoverTrigger,
  gatewayActivationEpoch, host
} from '@hermes/plugin-sdk'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-model-settings'
const RPC = `plugin.${ID}.settings`

export function parseTemperature(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Enter a temperature between 0 and 2.')
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > 2) throw new Error('Temperature must be between 0 and 2.')
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) throw new Error('Use increments of 0.01.')
  return Math.round(value * 100) / 100
}

function messageFor(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/32601|method.not.found|unknown.method/i.test(message)) {
    return 'Enable the Model Settings backend in this Hermes profile, then retry.'
  }
  return message || 'Could not load model settings. Retry when the gateway is connected.'
}

// Exported so the exact asynchronous production behavior can be tested without
// importing Hermes internals. The disk plugin remains one uncompiled ESM file.
export function createController(api, epoch) {
  let snapshot = { loading: true, saving: false, error: '', data: null, model: '' }
  let generation = 0
  let disposed = false
  let loadedScope = ''
  let loadedParams = null
  let scheduled = false
  const listeners = new Set()
  const scope = () => ({
    epoch: epoch(),
    profile: api.state.focusedSessionProfile?.get() || api.state.profile.get(),
    session_id: api.state.focusedSessionId.get(),
    owner: api.state.focusedSessionOwner?.get() ?? null,
    connectionId: api.state.connectionId?.get() || 'local',
    activeProfile: api.state.profile.get(),
    model: api.state.model.get(),
    gateway: api.state.gateway.get()
  })
  const fingerprint = value => JSON.stringify(value)
  const publish = patch => {
    if (disposed) return
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const current = (id, key) => !disposed && generation === id && fingerprint(scope()) === key

  async function refresh() {
    if (disposed) return
    if (snapshot.saving && loadedScope === fingerprint(scope())) return
    const id = ++generation
    const captured = scope()
    const key = fingerprint(captured)
    loadedScope = ''
    loadedParams = null
    publish({ loading: true, saving: false, error: '', data: null, model: captured.model || '' })
    const params = { profile: captured.profile }
    if (captured.session_id) params.session_id = captured.session_id
    try {
      if (captured.gateway !== 'open') throw new Error('Connect to a Hermes gateway to edit temperature.')
      if (api.state.focusedSessionOwner && captured.session_id && !captured.owner) {
        throw new Error('Hermes has not resolved this chat’s owner yet. Reopen the chat and retry.')
      }
      if (captured.profile !== captured.activeProfile || (captured.owner
          && captured.owner.connectionId !== captured.connectionId)) {
        throw new Error('Switch to this chat’s profile and gateway before editing its temperature.')
      }
      // runtime.describe rejects all parameters; the live connection owns scope.
      const runtime = await api.request('runtime.describe', {})
      if (!current(id, key)) return
      if (!Array.isArray(runtime.capabilities) || !runtime.capabilities.includes('plugin-rpc-v1')) {
        throw new Error('This gateway needs Hermes 0.23.1 or newer with plugin RPC support.')
      }
      const catalog = await api.request('model.options', params)
      if (!current(id, key)) return
      const providers = catalog.providers || []
      const row = providers.find(item => item.is_current)
        || providers.find(item => item.slug === catalog.provider || item.aliases?.includes(catalog.provider))
      const model = catalog.model || captured.model
      if (!row?.api_url || !model) {
        publish({ loading: false, model: model || '', data: { supported: false,
          reason: 'Select a configured custom Chat Completions model to use temperature controls.' } })
        return
      }
      // A fresh draft can have a local picker choice the gateway has not adopted.
      // Do not accidentally edit its profile default under that model's label.
      if (!captured.session_id && captured.model && model !== captured.model) {
        publish({ loading: false, model: captured.model, data: { supported: false,
          reason: 'Start this chat so Hermes can resolve the selected custom endpoint.' } })
        return
      }
      const routeParams = { ...params, provider: catalog.provider || row.slug, model, base_url: row.api_url }
      const data = await api.request(`${RPC}.get`, routeParams)
      if (!current(id, key)) return
      loadedScope = key
      loadedParams = routeParams
      publish({ loading: false, data, model })
    } catch (error) {
      if (current(id, key)) publish({ loading: false, error: messageFor(error) })
    }
  }

  async function save(temperature) {
    if (disposed || snapshot.loading || snapshot.saving || !snapshot.data?.supported) return false
    if (temperature !== null) parseTemperature(String(temperature))
    if (!loadedParams || loadedScope !== fingerprint(scope())) {
      await refresh()
      return false
    }
    const key = loadedScope
    const id = ++generation
    // Capture the route before dispatch. Later focus/model changes cannot retarget
    // this write, and its completion cannot overwrite the new view.
    const params = { ...loadedParams, temperature }
    publish({ saving: true, error: '' })
    try {
      const data = await api.request(`${RPC}.set`, params)
      if (!current(id, key)) return false
      publish({ saving: false, data })
      return true
    } catch (error) {
      if (current(id, key)) publish({ saving: false, error: messageFor(error) })
      return false
    }
  }

  function scheduleRefresh() {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!disposed) void refresh()
    })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    refresh, save, scheduleRefresh,
    dispose() { disposed = true; generation++; listeners.clear() }
  }
}

const muted = { color: 'var(--ui-text-secondary)', fontSize: '0.75rem', lineHeight: 1.5 }
const errorStyle = { color: 'var(--ui-text-primary)', fontSize: '0.75rem', lineHeight: 1.5 }

export function TemperatureControl({ controller }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const inputId = useId()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [inputError, setInputError] = useState('')
  const dirty = useRef(false)
  const draftRef = useRef('')
  const data = state.data
  const disabled = state.loading || state.saving || !data?.supported
  const temperature = data?.temperature
  const label = state.loading ? 'Temp: …' : data?.supported
    ? temperature == null ? 'Temp: Default' : `Temp: ${temperature.toFixed(2)}`
    : 'Temp: —'

  function resetDraft() {
    const value = data?.temperature ?? data?.default_temperature
    const next = value == null ? '' : value.toFixed(2)
    dirty.current = false
    draftRef.current = next
    setDraft(next)
    setInputError('')
  }

  useEffect(() => { resetDraft() }, [data])

  function change(value) {
    draftRef.current = value
    dirty.current = true
    setDraft(value)
    setInputError('')
  }

  async function commit() {
    if (!dirty.current || disabled) return
    try {
      const value = parseTemperature(draftRef.current)
      // Prevent Enter followed by blur from submitting twice. A failed save keeps
      // the draft available; editing or pressing Enter again retries it.
      dirty.current = false
      const attempted = controller.getSnapshot().data
      const saved = await controller.save(value)
      if (!saved && controller.getSnapshot().data === attempted) dirty.current = true
    } catch (error) { setInputError(messageFor(error)) }
  }

  let sliderValue = 1
  try { sliderValue = parseTemperature(draft) } catch { /* Default has no invented numeric value. */ }
  const status = state.saving ? 'Saving…' : state.loading ? 'Loading model settings…'
    : !data?.supported ? data?.reason || 'Model settings are unavailable.'
    : temperature == null
      ? data.default_temperature == null ? 'Using the model default. Choose a value to override it.'
        : `Using your configured default (${data.default_temperature.toFixed(2)}).`
      : 'Saved for this model. Applies to subsequent Desktop chat requests.'

  return jsxs(Popover, {
    open,
    onOpenChange(next) {
      setOpen(next)
      if (next) void controller.refresh()
      else resetDraft()
    },
    children: [
      jsx(PopoverTrigger, { asChild: true, children: jsx(Button, {
        type: 'button', variant: 'ghost', size: 'sm',
        title: 'Model temperature', 'aria-label': `Model temperature, ${label.replace('Temp: ', '')}`,
        style: { padding: '0.125rem 0.375rem', height: '1.625rem', fontSize: '0.75rem',
          color: 'var(--ui-text-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
        children: label
      }) }),
      jsxs(PopoverContent, {
        side: 'top', align: 'end', style: { width: '18rem', maxWidth: 'calc(100vw - 24px)', padding: '0.875rem' },
        children: [
          jsx('div', { style: { fontSize: '0.8125rem', fontWeight: 600 }, children: 'Model temperature' }),
          jsx('div', { style: { ...muted, overflowWrap: 'anywhere', marginTop: '0.125rem', marginBottom: '0.875rem' },
            children: state.model || 'No model selected' }),
          jsxs('div', { style: { display: 'flex', gap: '0.75rem', alignItems: 'center' }, children: [
            jsx('input', {
              type: 'range', min: 0, max: 2, step: 0.01, value: sliderValue, disabled,
              'aria-label': 'Temperature slider',
              style: { flex: 1, minWidth: 0, accentColor: 'var(--ui-accent)', cursor: disabled ? 'default' : 'pointer' },
              onChange: event => change(event.target.value),
              onPointerUp: () => void commit(),
              onPointerCancel: resetDraft,
              onKeyUp: event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void commit() },
              onBlur: () => void commit()
            }),
            jsx(Input, {
              id: inputId, type: 'number', inputMode: 'decimal', min: 0, max: 2, step: 0.01,
              disabled, value: draft, placeholder: 'Default', 'aria-label': 'Temperature value',
              'aria-invalid': Boolean(inputError), style: { width: '5.5rem', fontVariantNumeric: 'tabular-nums' },
              onChange: event => change(event.target.value),
              onBlur: () => void commit(),
              onKeyDown: event => {
                if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void commit() }
                if (event.key === 'Escape') resetDraft()
              }
            })
          ] }),
          jsxs('div', { style: { ...muted, display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem', marginRight: '6.25rem' },
            children: [jsx('span', { children: '0' }), jsx('span', { children: '2' })] }),
          jsx('p', { role: 'status', style: { ...muted, minHeight: '2.25rem', margin: '0.75rem 0' }, children: status }),
          inputError || state.error ? jsx('p', { role: 'alert', style: errorStyle, children: inputError || state.error }) : null,
          jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }, children: [
            jsx(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: disabled || temperature == null,
              onClick: () => { dirty.current = false; setInputError(''); void controller.save(null) }, children: 'Use model default' }),
            state.error ? jsx(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: state.loading || state.saving,
              onClick: () => void controller.refresh(), children: 'Retry' }) : null
          ] })
        ]
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Model Settings',
  defaultEnabled: false,
  register(ctx) {
    const controller = createController(host, gatewayActivationEpoch)
    ctx.register({ id: 'temperature', area: COMPOSER_AREAS.actions,
      render: () => jsx(TemperatureControl, { controller }) })
    const atoms = [host.state.focusedSessionId, host.state.focusedSessionProfile,
      host.state.focusedSessionOwner, host.state.connectionId,
      host.state.profile, host.state.model, host.state.gateway]
    for (const atom of atoms) {
      if (atom) ctx.onDispose(atom.subscribe(controller.scheduleRefresh))
    }
    ctx.onEvent('session.info', controller.scheduleRefresh)
    ctx.onEvent(`plugin.${ID}.settings.changed`, () => {
      if (!controller.getSnapshot().saving) controller.scheduleRefresh()
    })
    // Same-profile host switches need the epoch, even when every atom retains
    // its old value. Check cheaply without issuing periodic gateway requests.
    let lastEpoch = gatewayActivationEpoch()
    ctx.setInterval(() => {
      const next = gatewayActivationEpoch()
      if (next !== lastEpoch) { lastEpoch = next; controller.scheduleRefresh() }
    }, 500)
    ctx.onDispose(() => controller.dispose())
    controller.scheduleRefresh()
  }
}
