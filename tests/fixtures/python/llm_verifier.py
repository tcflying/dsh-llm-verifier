class _Usage:
    def __init__(self):
        self.reset_called = False

    def reset(self):
        self.reset_called = True

    def snapshot(self):
        if not self.reset_called:
            raise RuntimeError("usage must be reset before selection")
        return {"calls": 18, "input_tokens": 12, "output_tokens": 3}


USAGE = _Usage()


class _Result:
    index = 1
    scores = [0.2, 0.9]
    ranking = [1, 0]
    n_comparisons = 18


def select(**kwargs):
    assert kwargs["problem"] == "Fix the fixture"
    assert kwargs["candidates"] == ["candidate A", "candidate B"]
    assert kwargs["pivots"] == 1
    assert kwargs["n_evaluations"] == 2
    assert kwargs["seed"] == 0
    assert kwargs["on_error"] == "raise"
    assert kwargs["progress"] is False
    assert len(kwargs["criteria"]) == 3
    return _Result()
