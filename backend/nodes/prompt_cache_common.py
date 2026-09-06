from __future__ import annotations

import hashlib


def invalidate_key_fingerprint(invalidate_key: str | None) -> str:
  if invalidate_key is None:
    return ""
  return hashlib.sha256(invalidate_key.encode("utf-8")).hexdigest()


__all__ = ["invalidate_key_fingerprint"]
