"""Hermes entry point. All integration uses the public PluginContext API."""

from .backend import ModelSettings


def register(ctx):
    service = ModelSettings(ctx)
    ctx.register_rpc("settings.get", service.get_settings)
    ctx.register_rpc("settings.set", service.set_settings)
    ctx.register_hook("pre_llm_call", service.begin_turn)
    ctx.register_hook("on_session_end", service.end_turn)
    ctx.register_middleware("llm_request", service.rewrite_request)
    ctx.on_unload(service.close)
