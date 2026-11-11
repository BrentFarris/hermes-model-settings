# Validation

Checked on Windows against the installed Hermes 0.23.1 source/API contract.

| Check | Result |
| --- | --- |
| Python backend behavior | 11 tests passed |
| Hermes profile storage and concurrent writes | 2 integration tests passed |
| Serialized Chat Completions requests | 1 SDK integration test passed |
| React UI and asynchronous controller | 12 tests passed |
| Hermes plugin validation | All 16 checks passed; security verdict `safe` |
| Hermes plugin doctor | Discovery, manifest parsing, import and registration passed |

The wire test verifies that the selected temperature reaches the serialized request despite an existing `extra_body.temperature: 0`, then verifies that reset restores the original zero. It preserves thinking settings and messages. HTTP is intercepted in memory; no inference server is contacted.

UI checks cover slider/number synchronization, pointer and keyboard commits, invalid values, reset, failed writes, duplicate Enter/blur commits, model/profile changes during a save, stale responses, gateway switches, missing backend capabilities and disposal. They render the production plugin in React/jsdom with SDK component fixtures, not in the installed Desktop application.

Hermes validation and doctor were run through their CLI implementation functions (`validate_plugin_dir` and `doctor_plugin`) in disposable test state using the installed managed Python environment. This avoids the launcher's dependency-bootstrap step for a new test data root. No Hermes code was changed. The runtime parser prints an ignored `provides_middleware` field warning on this build; the validator requires that same declaration and confirms it matches registration.

The plugin has **not** been installed or enabled in the live Hermes profile, and has not sent a live model request. Installation and an installed-app smoke test remain user steps, as requested. Windows installation and enable instructions are in [README.md](README.md).
