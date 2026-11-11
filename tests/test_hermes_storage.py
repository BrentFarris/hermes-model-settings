"""Optional integration tests against Hermes' real profile-aware storage."""
from pathlib import Path
import tempfile
from concurrent.futures import ThreadPoolExecutor
import json
import unittest

from test_backend import backend, Context

try:
    from hermes_cli.plugins_state import PluginState
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
except ImportError:
    PluginState = None

try:
    import httpx
    from openai import OpenAI
except ImportError:
    OpenAI = None


@unittest.skipIf(PluginState is None, "Run with Hermes' Python environment for real storage tests")
class HermesStorageTests(unittest.TestCase):
    def test_disk_persistence_reset_and_profile_isolation(self):
        with tempfile.TemporaryDirectory(prefix="model-settings-storage-") as temp:
            profile_a, profile_b = Path(temp) / "a", Path(temp) / "b"
            token = set_hermes_home_override(profile_a)
            try:
                context = Context()
                context.state = PluginState("hermes-model-settings")
                config = {"custom_providers": [{"name": "local", "base_url": "http://localhost:8000/v1",
                                                 "api_mode": "chat_completions"}]}
                params = {"provider": "custom:local", "model": "model", "base_url": "http://localhost:8000/v1"}
                service = backend.ModelSettings(context, lambda: config)
                service.set_settings({**params, "temperature": 0})
                self.assertTrue(context.state.path.is_file())
                self.assertTrue(context.state.path.is_relative_to(profile_a))
                context.state = PluginState("hermes-model-settings")
                self.assertEqual(service.get_settings(params)["temperature"], 0)
                second = set_hermes_home_override(profile_b)
                try:
                    self.assertIsNone(service.get_settings(params)["temperature"])
                    service.set_settings({**params, "temperature": 1.5})
                finally:
                    reset_hermes_home_override(second)
                self.assertEqual(service.get_settings(params)["temperature"], 0)
                service.set_settings({**params, "temperature": None})
                self.assertIsNone(service.get_settings(params)["temperature"])
            finally:
                reset_hermes_home_override(token)


    def test_concurrent_model_writes_do_not_lose_each_other(self):
        with tempfile.TemporaryDirectory(prefix="model-settings-concurrent-") as temp:
            def write(index):
                token = set_hermes_home_override(temp)
                try:
                    PluginState("hermes-model-settings").set(f"model:{index}", index / 10)
                finally:
                    reset_hermes_home_override(token)
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(write, range(12)))
            token = set_hermes_home_override(temp)
            try:
                state = PluginState("hermes-model-settings")
                self.assertEqual([state.get(f"model:{index}") for index in range(12)], [index / 10 for index in range(12)])
            finally:
                reset_hermes_home_override(token)


@unittest.skipIf(OpenAI is None, "Run with Hermes' Python environment for SDK wire tests")
class ProviderWireTests(unittest.TestCase):
    def test_serialized_request_uses_override_then_original_extra_body_default(self):
        captured = []

        def respond(request):
            captured.append(json.loads(request.content))
            return httpx.Response(200, json={"id": "test", "object": "chat.completion", "created": 0,
                "model": "GLM-5.3-Flash", "choices": [{"index": 0,
                    "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]})

        context = Context()
        params = {"provider": "custom:glm-local", "model": "GLM-5.3-Flash", "base_url": "http://model.test/v1"}
        config = {"custom_providers": [{"name": "glm-local", "base_url": params["base_url"],
                                        "api_mode": "chat_completions", "extra_body": {"temperature": 0}}]}
        service = backend.ModelSettings(context, lambda: config)
        call = {**params, "api_mode": "chat_completions", "platform": "local", "task_id": "task", "turn_id": "turn"}
        service.begin_turn(**call)
        request = {"model": params["model"], "messages": [{"role": "user", "content": "test"}],
                   "temperature": 1, "extra_body": {"temperature": 0, "thinking": {"type": "enabled"}}}
        with httpx.Client(transport=httpx.MockTransport(respond)) as transport:
            with OpenAI(api_key="test-placeholder", base_url=params["base_url"], http_client=transport) as client:
                service.set_settings({**params, "temperature": 0.63})
                client.chat.completions.create(**service.rewrite_request(request, **call)["request"])
                service.set_settings({**params, "temperature": None})
                self.assertIsNone(service.rewrite_request(request, **call))
                client.chat.completions.create(**request)
        self.assertEqual([body["temperature"] for body in captured], [0.63, 0])
        self.assertEqual(captured[0]["thinking"], {"type": "enabled"})
        self.assertEqual(captured[0]["messages"], request["messages"])
