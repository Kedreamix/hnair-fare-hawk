import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import fetcher  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_query_gate(tmp_path, monkeypatch):
    """测试不共用真实的查价间隔文件，也不等待。"""
    monkeypatch.setattr(fetcher, "QUERY_GATE_PATH", tmp_path / "query_gate.json")
    monkeypatch.setattr(fetcher, "_min_query_interval", lambda: 0)
