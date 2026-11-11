# Hermes Model Settings

A temperature slider and number input for **custom Chat Completions models in Hermes Desktop**. The **Temp: Default** / **Temp: 0.70** button sits immediately before the model picker. Its popover uses Hermes' UI components and theme colors.

Requires **Hermes 0.23.1 or newer**, including the Desktop SDK and the gateway's `plugin-rpc-v1` capability. There are no additional Python dependencies and no frontend build step.

## Behavior

- Slider and number input stay synchronized; range **0–2**, step **0.01**.
- Releasing the slider saves. Number input saves on Enter or blur. Invalid input is rejected.
- Preferences are remembered per provider, endpoint and exact model ID, within the owning Hermes profile.
- Changes affect subsequent requests in **Desktop chat turns**. CLI, TUI, messaging, scheduled jobs, delegated subagents, titling, compression and background helpers keep their existing settings.
- **Use model default** clears the override. Hermes' original request is then passed through, including an existing `extra_body.temperature: 0`.
- The confirmed saved value stays in the button while a write is pending or has failed. Errors are displayed in the popover.
- Neither your prompt nor your conversation history is modified.

The custom endpoint's API mode must be explicitly **Chat Completions**. A matching main-model `api_mode: chat_completions` also qualifies. Auto-detected transports are not guessed: select the explicit mode in Hermes' provider settings first. The inference server must support the chosen temperature; the plugin does not suppress provider errors or change thinking effort.

The SDK offers a composer slot before the model picker, not an insertion point inside the native thinking-effort menu. This plugin uses that supported slot without modifying Hermes files, reaching into its DOM, or patching its internals.

## Install on Windows from this checkout

Creating the source repository does **not** install or enable the plugin. The following commands are installation steps for you to run when ready.

1. In PowerShell, link the checkout into your chosen Hermes profile's plugin directory. The default Windows data root is `%LOCALAPPDATA%\hermes`; a configured `HERMES_HOME` takes precedence. For a named profile, set `$hermesDataRoot` to that profile's actual data directory instead.

   ```powershell
   $pluginSource = 'C:\Users\brent\Documents\git\HermesPlugins\hermes-model-settings'
   $hermesDataRoot = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
   $pluginDirectory = Join-Path $hermesDataRoot 'plugins'
   $pluginLink = Join-Path $pluginDirectory 'hermes-model-settings'

   if (Test-Path -LiteralPath $pluginLink) { throw "A plugin already exists at $pluginLink" }
   New-Item -ItemType Directory -Force -Path $pluginDirectory | Out-Null
   New-Item -ItemType Junction -Path $pluginLink -Target $pluginSource
   hermes plugins enable hermes-model-settings
   ```

   Use `hermes -p <profile> plugins enable hermes-model-settings` when targeting a named profile. A junction uses the source directly, so uncommitted development changes are included; it does not require a Git push or a JavaScript build.

2. Open **Capabilities → Plugins** in Hermes Desktop and **Rescan**. Enable the **Model Settings** Desktop extension. A unified plugin has separate backend and Desktop enable switches; both are needed for the control to work.
3. Select your custom model. Set its provider API mode to **Chat Completions** if it is currently automatic. Open **Temp: Default**, choose a value, and send a new chat message.
4. If the UI is missing after Rescan, use the command palette's **Reload desktop plugins**. If the backend is unavailable, enable it in the profile that owns the chat and reconnect that profile.

The Desktop app manages its copy of the linked package's UI. To diagnose source/copy mismatches:

```powershell
hermes plugins doctor 'C:\Users\brent\Documents\git\HermesPlugins\hermes-model-settings'
```

To disable temperature overrides, run `hermes plugins disable hermes-model-settings` for the owning profile. Disabling only the Desktop extension hides the control; the separately enabled backend still applies saved settings. Stored preferences survive plugin disable/reload and remain in Hermes' profile-scoped plugin data.

## Scope and failure behavior

- A saved preference applies to all Desktop chats using that model and endpoint in the same profile. It is not a per-chat override.
- Open the popover to refresh values saved in another window. Session/model changes also refresh it.
- A fresh draft whose local model choice has not reached the gateway asks you to start the chat before editing, rather than saving against the wrong default model.
- When a focused tile belongs to a different gateway/profile from the active connection, switch to its owner before editing. Ambiguous ownership disables editing. Pending responses from an old model/profile/connection cannot overwrite the new view.
- A plugin enabled halfway through a running turn begins applying overrides on the next Desktop turn. Active-turn bookkeeping survives transcript compression, and is removed when a turn ends or the plugin unloads.
- Providers using Responses, Anthropic Messages, subscription transports or automatic API-mode detection are outside v1.
- Temperature supports the UI's range only; this is not a guarantee that every server accepts every value in that range.

## Data and interfaces

The Python entry point registers two RPC methods under `plugin.hermes-model-settings`:

| Method | Input | Result |
| --- | --- | --- |
| `settings.get` | `provider`, `base_url`, `model`; optional routing `profile` / `session_id` | `supported`, canonical `route`, saved `temperature`, known `default_temperature`; or an unsupported reason |
| `settings.set` | Same identity plus `temperature` (number or `null`) | The confirmed settings snapshot; invalid input produces an RPC error |

`null` means inheritance, not temperature zero. The state facade stores a null tombstone on reset. Keys are hashes of the normalized provider/endpoint/model identity, and values are the numeric override or null. Hermes owns the profile-scoped state directory and atomic writes through `ctx.state`; no settings are written into the plugin checkout or into Hermes' model configuration.

Lifecycle hooks `pre_llm_call` and `on_session_end` identify real Desktop turns; `llm_request` applies overrides only to matching task/turn IDs and actual Chat Completions requests. It removes a conflicting `extra_body.temperature` while preserving every other request field. These hooks do not retain messages or conversation history.

The plugin reads configured endpoint metadata and its own preferences, makes gateway RPC calls, and adds the selected temperature to an existing model request. It creates no extra inference requests, collects no telemetry, and neither reads credential files nor requests new credentials.

## Development and tests

Python behavior tests use only the standard library:

```powershell
python -B -m unittest discover -s tests -v
```

The two real storage tests run when Hermes modules are available in the selected Python interpreter; otherwise they explicitly skip. They use temporary profile directories, never your live Hermes state. An additional SDK wire test captures serialized Chat Completions requests through an in-memory HTTP transport; it runs when Hermes' OpenAI/HTTPX dependencies are available and makes no network requests.

UI tests render the actual plugin with React and a minimal SDK fixture, and exercise the asynchronous controller and native input events:

```powershell
npm install
npm test
```

The dev dependencies are for testing only. Alternatively, set `HERMES_DESKTOP_DIR` to an existing Hermes Desktop source directory with its dependencies installed; the tests can reuse those packages without installing or modifying anything there.

Run the host checks using Hermes' own installed interpreter/CLI, with `HERMES_HOME`, `HERMES_RUNTIME_DIR`, `TEMP` and `TMP` pointing to disposable test directories:

```powershell
hermes plugins validate 'C:\Users\brent\Documents\git\HermesPlugins\hermes-model-settings' --json
hermes plugins doctor 'C:\Users\brent\Documents\git\HermesPlugins\hermes-model-settings'
```

Hermes 0.23.1's runtime parser may print an ignored `provides_middleware` manifest-field warning even though its validator requires that field to declare middleware registrations. Keep the declaration; validation and runtime registration still pass.

See [VALIDATION.md](VALIDATION.md) for the checked build and validation results. MIT licensed; see [LICENSE](LICENSE).
