# One-check regression for the DeepSeekClient lazy-proxy guards in verifier_bridge.py.
# Run: python docs/proof/tools/bridge-guard924.py   (from the repo root)
# Fails if __getattr__ stops refusing its own bookkeeping names: an instance that never ran __init__
# would recurse forever (self._client -> __getattr__ -> _build -> self._client) instead of raising.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "python"))
import verifier_bridge as vb  # noqa: E402

try:
    vb.DeepSeekClient.__new__(vb.DeepSeekClient).chat
    raise AssertionError("NO-RAISE: __getattr__ forwarded a bookkeeping name")
except RecursionError:
    raise AssertionError("STILL-RECURSES: the _client/_lock/_model refusal was removed") from None
except AttributeError as e:
    # Bare asserts are stripped under `python -O` (measured 2026-09-28: the guard printed
    # BRIDGE GUARD CHECK OK with exit 0 on a broken bridge), so every judgement here is an
    # explicit SystemExit that survives optimization.
    if "without __init__" not in str(e):
        raise SystemExit(f"BRIDGE GUARD FAIL: wrong AttributeError text: {e}")

# Control: a normally built instance must still forward, and still refuse to let <cwd>/.env pick the
# backend. Without this second half the guard could pass by raising AttributeError for *every* name.
d = vb.DeepSeekClient("MiniMax-M3")
if not (d._client is None and hasattr(d, "_lock")):
    raise SystemExit("BRIDGE GUARD FAIL: __init__ no longer publishes its own fields")
try:
    d.chat
    raise AssertionError("FORWARDED without DEEPSEEK_API_KEY set")
except RuntimeError as e:
    if "DEEPSEEK_API_KEY" not in str(e):
        raise SystemExit(f"BRIDGE GUARD FAIL: wrong build-time refusal: {e}")

print("BRIDGE GUARD CHECK OK")
