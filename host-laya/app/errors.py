"""Exceptions shared by the engine and the API, kept free of torch so the API
layer can be imported (and tested) without a GPU stack installed."""


class EngineNotReady(RuntimeError):
    """Raised when a request arrives before the checkpoint is resident."""


class BadQuestion(ValueError):
    """A question Laya cannot encode - too many options for the head budget."""
