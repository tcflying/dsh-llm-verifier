#!/usr/bin/env python3
"""Strict stdin/stdout JSON bridge to llm-verifier."""

import contextlib
import json
import math
import os
import re
import sys
import threading
from typing import Any, Dict, List

# The Node host writes the request as UTF-8 bytes; on Windows Python would
# otherwise decode stdin with the locale codepage (for example cp936) and
# corrupt every non-ASCII trajectory byte.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


CRITERIA = {
    "Specification adherence": (
        "Does the candidate satisfy the requested task and all explicit constraints? "
        "Judge the actual patch and terminal evidence, not the candidate's claims."
    ),
    "Output match": (
        "Do the implemented files and observed validation outputs match the intended result? "
        "Trust terminal output over narrative assertions."
    ),
    "Error signal detection": (
        "Did the candidate correctly notice and handle errors, failed commands, and incomplete work? "
        "Penalize any success claim contradicted by terminal evidence."
    ),
}

# Mirrors the caller's rule in src/settings.ts, so a model id the settings
# document rejects never reaches this process.
MODEL_PATTERN = re.compile(r"deepseek-[A-Za-z0-9][A-Za-z0-9._-]*\Z")


def require_object(value: Any, field_name: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("{} must be an object, got {!r}".format(field_name, value))
    return value


def require_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("{} must be a non-empty string, got {!r}".format(field_name, value))
    return value


def require_integer(value: Any, field_name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise ValueError(
            "{} must be an integer from {} to {}, got {!r}".format(
                field_name, minimum, maximum, value
            )
        )
    return value


def read_request() -> Dict[str, Any]:
    raw_request = sys.stdin.read()
    if not raw_request:
        raise ValueError("stdin must contain one JSON request")
    try:
        parsed_request = json.loads(raw_request)
    except json.JSONDecodeError as error:
        raise ValueError("stdin contains invalid JSON: {}".format(error)) from error
    return require_object(parsed_request, "request")


def normalize_request(request: Dict[str, Any]) -> Dict[str, Any]:
    task = require_string(request.get("task"), "task")
    model = require_string(request.get("model"), "model")
    if MODEL_PATTERN.match(model) is None:
        raise ValueError(
            "model must begin with 'deepseek-' followed by a letter or digit, got {!r}".format(model)
        )
    cache_path = require_string(request.get("cachePath"), "cachePath")
    if not os.path.isabs(cache_path):
        raise ValueError("cachePath must be absolute, got {!r}".format(cache_path))

    raw_candidates = request.get("candidates")
    if not isinstance(raw_candidates, list) or not 2 <= len(raw_candidates) <= 5:
        raise ValueError("candidates must contain 2-5 items, got {!r}".format(raw_candidates))
    candidate_ids: List[str] = []
    trajectories: List[str] = []
    for candidate_index, raw_candidate in enumerate(raw_candidates):
        candidate = require_object(raw_candidate, "candidates[{}]".format(candidate_index))
        candidate_ids.append(
            require_string(candidate.get("candidateId"), "candidates[{}].candidateId".format(candidate_index))
        )
        trajectories.append(
            require_string(candidate.get("trajectory"), "candidates[{}].trajectory".format(candidate_index))
        )
    if len(set(candidate_ids)) != len(candidate_ids):
        raise ValueError("candidateId values must be unique, got {!r}".format(candidate_ids))

    pivots = require_integer(request.get("pivots"), "pivots", 1, 2)
    if pivots >= len(trajectories):
        raise ValueError(
            "pivots must be smaller than candidate count {}, got {}".format(len(trajectories), pivots)
        )
    return {
        "task": task,
        "model": model,
        "cache_path": cache_path,
        "trajectories": trajectories,
        "pivots": pivots,
        "n_evaluations": require_integer(request.get("nEvaluations"), "nEvaluations", 1, 4),
        "max_workers": require_integer(request.get("maxWorkers"), "maxWorkers", 1, 16),
    }


def clear_competing_backend_environment() -> None:
    for environment_name in list(os.environ):
        if (
            environment_name == "OPENAI_BASE_URL"
            or environment_name == "GOOGLE_GENAI_USE_VERTEXAI"
            or environment_name.startswith("GOOGLE_CLOUD_")
            or environment_name.startswith("VERTEX_")
        ):
            os.environ.pop(environment_name, None)


class DeepSeekClient:
    """Stand-in for the verifier client, built only when a comparison is
    actually scored, so a run served entirely from the cache needs no key.

    Handing this to `select(client=...)` keeps the library's env-driven
    `create_client()` out of reach: that helper re-reads `<cwd>/.env`, and a
    `.env` left in the spawn directory would otherwise repoint the backend at
    an arbitrary host, which then receives the API key and every candidate
    trajectory and returns the verdict. `create_deepseek_client()` pins
    base_url to api.deepseek.com, so only DeepSeek can be the judge here.
    """

    def __init__(self, model: str) -> None:
        self._model = model
        self._client: Any = None
        self._lock = threading.Lock()

    def _build(self) -> Any:
        client = self._client
        if client is not None:
            return client
        # The pool shares this one wrapper: llm_verifier hands `client` to every worker
        # (fine_grained_reward.py:860/:883), and each of them reaches `_build` through `__getattr__`
        # at the same moment. `create_deepseek_client()` re-reads `<cwd>/.env` through `load_dotenv`,
        # i.e. it yields the GIL on file I/O, so the unbolted check-then-act built up to `maxWorkers`
        # clients and kept one. Double-checked under a lock: the built path stays lock-free.
        with self._lock:
            if self._client is None:
                api_key = os.environ.get("DEEPSEEK_API_KEY")
                if not api_key:
                    raise RuntimeError(
                        "DEEPSEEK_API_KEY is not set in the bridge process environment; "
                        "refusing to let <cwd>/.env choose the verifier backend"
                    )
                from llm_verifier.fine_grained_reward import create_deepseek_client

                self._client = create_deepseek_client(api_key=api_key, model=self._model)
            return self._client

    def __getattr__(self, name: str) -> Any:
        # Without this, an instance that was never through __init__ (`__new__`, a future copy/pickle
        # path) recurses forever: `self._client` misses __dict__ -> __getattr__ -> _build -> `self._client`.
        # Only these three names: a blanket dunder block would stop forwarding the real client's dunders.
        if name in ("_client", "_lock", "_model"):
            raise AttributeError(f"{type(self).__name__} has no {name!r}: it was built without __init__")
        return getattr(self._build(), name)


def run_selection(request: Dict[str, Any]) -> Dict[str, Any]:
    clear_competing_backend_environment()
    import llm_verifier  # Imported after backend environment normalization.

    llm_verifier.USAGE.reset()
    with contextlib.redirect_stdout(sys.stderr):
        verifier_result = llm_verifier.select(
            problem=request["task"],
            candidates=request["trajectories"],
            criteria=CRITERIA,
            n_evaluations=request["n_evaluations"],
            pivots=request["pivots"],
            seed=0,
            max_workers=request["max_workers"],
            model=request["model"],
            cache=request["cache_path"],
            progress=False,
            on_error="raise",
            client=DeepSeekClient(request["model"]),
        )
    scores = [float(score) for score in verifier_result.scores]
    ranking = [int(candidate_index) for candidate_index in verifier_result.ranking]
    for score_index, score_value in enumerate(scores):
        if not math.isfinite(score_value):
            raise RuntimeError(
                "verifier produced a non-finite score at index {}: {!r}".format(
                    score_index, score_value
                )
            )
    if len(set(scores)) < 2:
        raise RuntimeError(
            "verifier produced a non-discriminating score vector: {!r}".format(scores)
        )
    token_usage = llm_verifier.USAGE.snapshot()
    request_count = token_usage.get("calls")
    if isinstance(request_count, bool) or not isinstance(request_count, int) or request_count < 0:
        raise RuntimeError("USAGE.snapshot() returned invalid calls: {!r}".format(request_count))
    return {
        "winnerIndex": int(verifier_result.index),
        "scores": scores,
        "ranking": ranking,
        "requestCount": request_count,
        "tokenUsage": token_usage,
    }


def main() -> int:
    request = normalize_request(read_request())
    result = run_selection(request)
    payload = json.dumps(result, separators=(",", ":"), sort_keys=True, allow_nan=False)
    sys.stdout.write(payload + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # Boundary: report a failed bridge process, never a fake winner.
        secret = os.environ.get("DEEPSEEK_API_KEY", "")
        message = str(error)
        if secret:
            message = message.replace(secret, "[REDACTED]")
        sys.stderr.write("verifier_bridge: {}\n".format(message))
        raise SystemExit(1)
