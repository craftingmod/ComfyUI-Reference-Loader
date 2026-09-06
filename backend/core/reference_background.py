from __future__ import annotations

import importlib.util
import logging
import threading
from typing import Any


class ReferenceBackgroundRemovalError(RuntimeError):
  """Raised when automatic foreground extraction cannot be completed."""


class ReferenceBackgroundRemovalUnavailable(ReferenceBackgroundRemovalError):
  """Raised when the optional rembg runtime is not installed."""


_SESSION: Any | None = None
_SESSION_LOCK = threading.Lock()
_RUNTIME_LOGGED = False
_LOGGER = logging.getLogger(__name__)


def _provider_device(providers: tuple[str, ...]) -> str:
  if any(
    any(
      marker in provider.upper()
      for marker in (
        "CUDA",
        "TENSORRT",
        "ROCM",
        "DIRECTML",
        "COREML",
        "MIGRAPHX",
        "QNN",
      )
    )
    for provider in providers
  ):
    return "GPU"
  if "CPUExecutionProvider" in providers:
    return "CPU"
  return "unknown"


def _session_providers(session: Any) -> tuple[str, ...]:
  for candidate in (getattr(session, "inner_session", None), session):
    get_providers = getattr(candidate, "get_providers", None)
    if callable(get_providers):
      return tuple(str(provider) for provider in get_providers())
    providers = getattr(candidate, "providers", None)
    if providers:
      return tuple(str(provider) for provider in providers)
  return ()


def _log_runtime_status(
  *,
  rembg_installed: bool,
  onnxruntime_installed: bool,
  onnxruntime: Any = None,
  session: Any = None,
) -> None:
  global _RUNTIME_LOGGED
  if _RUNTIME_LOGGED:
    return
  available_providers = (
    tuple(str(provider) for provider in onnxruntime.get_available_providers())
    if onnxruntime is not None
    else ()
  )
  active_providers = _session_providers(session) if session is not None else ()
  _LOGGER.info(
    "rembg runtime: rembg_installed=%s, onnxruntime_installed=%s, "
    "onnxruntime_version=%s, available_providers=%s, active_providers=%s, device=%s",
    rembg_installed,
    onnxruntime_installed,
    getattr(onnxruntime, "__version__", "unknown")
    if onnxruntime is not None
    else "unknown",
    available_providers or "unknown",
    active_providers or "unknown",
    _provider_device(active_providers),
  )
  _RUNTIME_LOGGED = True


def remove_reference_background(image: Any) -> Any:
  """Return a same-sized RGBA foreground using a lazily cached rembg session."""

  global _SESSION
  rembg_installed = importlib.util.find_spec("rembg") is not None
  onnxruntime_installed = importlib.util.find_spec("onnxruntime") is not None
  if not rembg_installed or not onnxruntime_installed:
    _log_runtime_status(
      rembg_installed=rembg_installed,
      onnxruntime_installed=onnxruntime_installed,
    )
    raise ReferenceBackgroundRemovalUnavailable(
      'Automatic background removal requires the optional "rembg" extra. '
      'Install this project with `pip install ".[rembg]"` in the ComfyUI environment.'
    )
  with _SESSION_LOCK:
    try:
      from rembg import new_session, remove
    except (ImportError, ModuleNotFoundError, SystemExit) as exc:
      raise ReferenceBackgroundRemovalUnavailable(
        "Automatic background removal requires rembg with a CPU or GPU ONNX runtime."
      ) from exc
    try:
      try:
        import onnxruntime
      except (ImportError, ModuleNotFoundError, SystemExit):
        onnxruntime = None
      if _SESSION is None:
        _SESSION = new_session()
      _log_runtime_status(
        rembg_installed=rembg_installed,
        onnxruntime_installed=onnxruntime_installed,
        onnxruntime=onnxruntime,
        session=_SESSION,
      )
      result = remove(image.convert("RGBA"), session=_SESSION)
    except Exception as exc:
      raise ReferenceBackgroundRemovalError(
        "rembg could not remove the image background."
      ) from exc
  if not hasattr(result, "convert") or getattr(result, "size", None) != getattr(
    image, "size", None
  ):
    raise ReferenceBackgroundRemovalError("rembg returned an invalid image result.")
  return result.convert("RGBA")


__all__ = [
  "ReferenceBackgroundRemovalError",
  "ReferenceBackgroundRemovalUnavailable",
  "remove_reference_background",
]
