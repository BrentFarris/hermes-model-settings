"""Profile-scoped temperature preferences and Desktop-only request middleware."""

from collections import OrderedDict
from dataclasses import dataclass
from hashlib import sha256
import json
import math
from threading import RLock
from urllib.parse import urlsplit, urlunsplit


def validate_temperature(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError("Temperature must be a number between 0 and 2, or null for default.")
    if not math.isfinite(value) or not 0 <= value <= 2:
        raise ValueError("Temperature must be between 0 and 2.")
    rounded = round(value, 2)
    if abs(value - rounded) > 1e-9:
        raise ValueError("Temperature must use increments of 0.01.")
    return rounded


def normalize_endpoint(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 2048:
        raise ValueError("A configured custom endpoint is required.")
    url = urlsplit(value.strip())
    if (url.scheme not in {"http", "https"} or not url.hostname or url.username
            or url.password or url.query or url.fragment):
        raise ValueError("Use an HTTP(S) base URL without credentials, a query, or a fragment.")
    host = url.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    port = url.port
    if port and (url.scheme, port) not in {("http", 80), ("https", 443)}:
        host += f":{port}"
    return urlunsplit((url.scheme, host, url.path.rstrip("/"), "", ""))


@dataclass(frozen=True)
class Route:
    provider: str
    base_url: str
    model: str

    def as_dict(self):
        return {"provider": self.provider, "base_url": self.base_url, "model": self.model}

    @property
    def state_key(self):
        encoded = json.dumps(self.as_dict(), sort_keys=True, separators=(",", ":"))
        return "temperature:" + sha256(encoded.encode("utf-8")).hexdigest()


def custom_routes(config):
    """Read only configured endpoint metadata; never return credentials to the UI."""
    rows = config.get("custom_providers", [])
    if isinstance(rows, list):
        for row in rows:
            if isinstance(row, dict) and row.get("base_url"):
                yield str(row.get("name", "")), row
    providers = config.get("providers", {})
    if isinstance(providers, dict):
        for name, row in providers.items():
            if isinstance(row, dict) and row.get("base_url"):
                yield name, row
    main = config.get("model", {})
    if isinstance(main, dict) and main.get("provider") == "custom" and main.get("base_url"):
        yield "custom", main


def resolve_route(config, params):
    model = params.get("model")
    provider = params.get("provider")
    if not isinstance(model, str) or not model.strip() or len(model) > 512:
        raise ValueError("Choose a model before setting temperature.")
    if not isinstance(provider, str) or not provider or len(provider) > 256:
        raise ValueError("Choose a custom provider before setting temperature.")
    endpoint = normalize_endpoint(params.get("base_url"))
    matches = []
    for name, row in custom_routes(config):
        if provider not in {"custom", name, f"custom:{name}"}:
            continue
        try:
            if normalize_endpoint(row["base_url"]) == endpoint:
                matches.append(row)
        except (ValueError, TypeError):
            continue
    if not matches:
        raise ValueError("Temperature controls support configured custom endpoints only.")
    # A named endpoint carries its transport configuration even if the main model
    # points at the same URL using the generic 'custom' provider alias.
    row = matches[0]
    mode = row.get("api_mode", "auto") or "auto"
    main = config.get("model", {})
    if mode == "auto" and isinstance(main, dict) and main.get("base_url"):
        try:
            if normalize_endpoint(main["base_url"]) == endpoint:
                mode = main.get("api_mode", "auto") or "auto"
        except ValueError:
            pass
    if mode != "chat_completions":
        raise ValueError("Select Chat Completions as this custom endpoint's API mode to use temperature controls.")
    return Route("custom", endpoint, model), row


def configured_temperature(config, row, model):
    model_entry = (row.get("models") or {}).get(model, {}) if isinstance(row.get("models"), dict) else {}
    sources = [model_entry, row]
    main = config.get("model", {})
    if isinstance(main, dict) and main.get("default") == model and main.get("base_url") == row.get("base_url"):
        sources.append(main)
    sources.append(config.get("agent", {}))
    for source in sources:
        if not isinstance(source, dict):
            continue
        extra = source.get("extra_body", {})
        value = extra.get("temperature") if isinstance(extra, dict) else None
        if value is None:
            value = source.get("temperature")
        if value is not None:
            try:
                return validate_temperature(value)
            except ValueError:
                return None
    return None


class ModelSettings:
    def __init__(self, ctx, config_reader=None):
        self.ctx = ctx
        self._config_reader = config_reader
        self._turns = OrderedDict()
        self._lock = RLock()
        self._closed = False

    def config(self):
        if self._config_reader is not None:
            return self._config_reader()
        from hermes_cli.config import load_config_readonly
        return load_config_readonly() or {}

    def _snapshot(self, route, row, config):
        temperature = validate_temperature(self.ctx.state.get(route.state_key))
        return {
            "supported": True,
            "route": route.as_dict(),
            "temperature": temperature,
            "default_temperature": configured_temperature(config, row, route.model),
        }

    def get_settings(self, params, *, session_id=None, **kwargs):
        config = self.config()
        try:
            route, row = resolve_route(config, params)
        except ValueError as exc:
            return {"supported": False, "reason": str(exc)}
        return self._snapshot(route, row, config)

    def set_settings(self, params, *, session_id=None, **kwargs):
        if "temperature" not in params:
            raise ValueError("The temperature field is required; null restores the model default.")
        value = validate_temperature(params["temperature"])
        config = self.config()
        route, row = resolve_route(config, params)
        # The public state facade locks each update and follows the owning profile.
        # Null is a tombstone: reset needs no unsupported delete/file operation.
        self.ctx.state.set(route.state_key, value)
        result = self._snapshot(route, row, config)
        if session_id:
            self.ctx.emit_to_session(session_id, "settings.changed", {"route": route.as_dict()})
        return result

    def begin_turn(self, *, task_id="", turn_id="", platform="", parent_session_id="", **kwargs):
        if (not task_id or not turn_id or parent_session_id or platform in {"subagent", "cron"}
                or self.ctx.session_surface() != "desktop"):
            return
        with self._lock:
            if self._closed:
                return
            key = (self.ctx.profile_name, task_id, turn_id)
            self._turns[key] = True
            # Bound orphaned bookkeeping if Hermes is interrupted before its end hook.
            while len(self._turns) > 4096:
                self._turns.popitem(last=False)

    def end_turn(self, *, task_id="", turn_id="", **kwargs):
        with self._lock:
            self._turns.pop((self.ctx.profile_name, task_id, turn_id), None)

    def rewrite_request(self, request, *, task_id="", turn_id="", platform="", provider="",
                        model="", base_url="", api_mode="", **kwargs):
        if api_mode != "chat_completions" or platform in {"subagent", "cron"}:
            return None
        with self._lock:
            if self._closed or (self.ctx.profile_name, task_id, turn_id) not in self._turns:
                return None
        # Eligible turn IDs come only from pre_llm_call. Auxiliary forks either
        # skip that hook or use a different task/turn, even with the same session ID.
        try:
            route, _ = resolve_route(self.config(), {"provider": provider, "model": model, "base_url": base_url})
        except ValueError:
            return None
        value = validate_temperature(self.ctx.state.get(route.state_key))
        if value is None:
            return None
        updated = {**request, "temperature": value}
        extra = request.get("extra_body")
        if isinstance(extra, dict) and "temperature" in extra:
            updated["extra_body"] = {key: item for key, item in extra.items() if key != "temperature"}
        return {"request": updated, "source": "hermes-model-settings", "reason": "Desktop model temperature"}

    def close(self):
        with self._lock:
            self._closed = True
            self._turns.clear()
