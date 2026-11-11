"""Behavior tests: run with python -m unittest discover -s tests -v."""

from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("model_settings_backend", ROOT / "backend.py")
backend = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = backend
spec.loader.exec_module(backend)


class ProfileState:
    def __init__(self, ctx):
        self.ctx = ctx
        self.values = {}

    def get(self, key, default=None):
        return self.values.get((self.ctx.profile_name, key), default)

    def set(self, key, value):
        self.values[self.ctx.profile_name, key] = value


class Context:
    profile_name = "default"
    surface = "desktop"

    def __init__(self):
        self.state = ProfileState(self)
        self.events = []

    def session_surface(self):
        return self.surface

    def emit_to_session(self, *args):
        self.events.append(args)


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.ctx = Context()
        self.config = {
            "model": {"provider": "custom", "default": "GLM-5.3-Flash",
                      "base_url": "http://model.test:8023/v1", "api_mode": "chat_completions"},
            "custom_providers": [
                {"name": "glm-local", "base_url": "http://model.test:8023/v1", "extra_body": {"temperature": 0}},
                {"name": "second", "base_url": "http://second.test/v1", "api_mode": "chat_completions"},
            ],
        }
        self.service = backend.ModelSettings(self.ctx, lambda: self.config)
        self.params = {"provider": "custom:glm-local", "base_url": "http://model.test:8023/v1", "model": "GLM-5.3-Flash"}
        self.call = {"task_id": "task-1", "turn_id": "turn-1", "platform": "local", "provider": "custom",
                     "base_url": self.params["base_url"], "model": self.params["model"], "api_mode": "chat_completions"}

    def save(self, value, **changes):
        return self.service.set_settings({**self.params, **changes, "temperature": value}, session_id="chat-1")

    def begin(self, **changes):
        self.service.begin_turn(**{**self.call, **changes})

    def test_default_and_zero_persist_across_instances(self):
        initial = self.service.get_settings(self.params)
        self.assertIsNone(initial["temperature"])
        self.assertEqual(initial["default_temperature"], 0)
        self.save(0)
        reopened = backend.ModelSettings(self.ctx, lambda: self.config)
        self.assertEqual(reopened.get_settings(self.params)["temperature"], 0)
        self.assertEqual(self.ctx.events[-1][0:2], ("chat-1", "settings.changed"))

    def test_value_bounds_precision_and_required_field(self):
        for value in (True, False, "0.7", [], {}, float("nan"), float("inf"), -0.01, 2.01, 0.705):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.save(value)
        with self.assertRaises(ValueError):
            self.service.set_settings(self.params)
        for value in (0, 0.01, 0.7, 2):
            self.assertEqual(self.save(value)["temperature"], value)

    def test_actual_payload_overrides_extra_body_without_mutating_original(self):
        self.save(0.72)
        self.begin()
        original = {"model": "GLM-5.3-Flash", "temperature": 1, "messages": [{"role": "user", "content": "Hi"}],
                    "extra_body": {"temperature": 0, "thinking": {"type": "enabled"}}, "stream": True}
        before = deepcopy(original)
        wire = self.service.rewrite_request(original, **self.call)["request"]
        self.assertEqual(wire["temperature"], 0.72)
        self.assertNotIn("temperature", wire["extra_body"])
        self.assertEqual(wire["extra_body"]["thinking"], {"type": "enabled"})
        self.assertEqual(wire["messages"], original["messages"])
        self.assertEqual(original, before)
        self.save(0)
        self.assertEqual(self.service.rewrite_request(original, **self.call)["request"]["temperature"], 0)

    def test_reset_restores_original_config_and_new_requests_read_new_values(self):
        self.begin()
        request = {"extra_body": {"temperature": 0}}
        self.save(1)
        self.assertEqual(self.service.rewrite_request(request, **self.call)["request"]["temperature"], 1)
        self.save(1.23)
        self.assertEqual(self.service.rewrite_request(request, **self.call)["request"]["temperature"], 1.23)
        self.save(None)
        self.assertIsNone(self.service.rewrite_request(request, **self.call))
        self.assertEqual(request, {"extra_body": {"temperature": 0}})

    def test_model_endpoint_and_profile_isolation(self):
        self.save(0.35)
        self.assertIsNone(self.service.get_settings({**self.params, "model": "another-model"})["temperature"])
        self.assertIsNone(self.service.get_settings({**self.params, "provider": "custom:second",
            "base_url": "http://second.test/v1"})["temperature"])
        self.ctx.profile_name = "other"
        self.assertIsNone(self.service.get_settings(self.params)["temperature"])
        self.save(1.3)
        self.ctx.profile_name = "default"
        self.assertEqual(self.service.get_settings(self.params)["temperature"], 0.35)

    def test_url_normalization_and_provider_aliases(self):
        self.save(0.5)
        query = {**self.params, "provider": "glm-local", "base_url": "HTTP://MODEL.TEST:8023/v1/"}
        self.assertEqual(self.service.get_settings(query)["temperature"], 0.5)
        self.assertEqual(backend.normalize_endpoint("https://EXAMPLE.test:443/v1/"), "https://example.test/v1")
        self.assertEqual(backend.normalize_endpoint("http://[::1]:8000/v1/"), "http://[::1]:8000/v1")
        self.assertNotEqual(backend.normalize_endpoint("http://a/v1"), backend.normalize_endpoint("http://a/V1"))

    def test_no_credentials_unconfigured_or_builtin_routes(self):
        for changes in ({"provider": "openai"}, {"base_url": "https://unknown.test/v1"},
                        {"base_url": "http://user:secret@model.test/v1"},
                        {"base_url": "http://model.test/v1?api_key=secret"}, {"model": ""}):
            with self.subTest(changes=changes):
                self.assertFalse(self.service.get_settings({**self.params, **changes})["supported"])
                with self.assertRaises(ValueError):
                    self.save(0.5, **changes)

    def test_excludes_cli_tui_messaging_cron_and_subagents(self):
        self.save(0.7)
        for surface in ("cli", "tui", "acp", "telegram", "discord", ""):
            with self.subTest(surface=surface):
                self.ctx.surface = surface
                self.begin()
                self.assertIsNone(self.service.rewrite_request({}, **self.call))
        self.ctx.surface = "desktop"
        for changes in ({"platform": "cron"}, {"platform": "subagent"}, {"parent_session_id": "parent"}):
            self.begin(**changes)
            self.assertIsNone(self.service.rewrite_request({}, **self.call))

    def test_auxiliary_forks_cannot_borrow_parent_turn_or_session(self):
        self.save(0.9)
        self.begin()
        self.assertIsNone(self.service.rewrite_request({}, **{**self.call, "task_id": "aux-task"}))
        self.assertIsNone(self.service.rewrite_request({}, **{**self.call, "turn_id": "turn-1:side_question"}))
        self.assertIsNone(self.service.rewrite_request({}, **{**self.call, "turn_id": ""}))
        self.assertIsNone(self.service.rewrite_request({}, **{**self.call, "platform": "subagent"}))

    def test_end_unload_reload_and_compression(self):
        self.save(0.7)
        self.begin(session_id="before-compression")
        self.assertIsNotNone(self.service.rewrite_request({}, session_id="after-compression", **self.call))
        self.service.end_turn(**self.call)
        self.assertIsNone(self.service.rewrite_request({}, **self.call))
        self.begin()
        self.service.close()
        self.begin()
        self.assertIsNone(self.service.rewrite_request({}, **self.call))
        self.service = backend.ModelSettings(self.ctx, lambda: self.config)
        self.begin()
        self.assertEqual(self.service.rewrite_request({}, **self.call)["request"]["temperature"], 0.7)

    def test_transport_restrictions(self):
        self.save(0.7)
        self.begin()
        for mode in ("responses", "codex_responses", "anthropic_messages", ""):
            self.assertIsNone(self.service.rewrite_request({}, **{**self.call, "api_mode": mode}))
        self.config["model"]["api_mode"] = "responses"
        self.assertFalse(self.service.get_settings(self.params)["supported"])


if __name__ == "__main__":
    unittest.main()
