"""tests/conftest.py must reset model_manager's shutdown state between tests.

Any test that boots the app lifespan (``with TestClient(main.app)``) leaves
``model_manager._shutting_down`` set and the GPU pool torn down, as graceful
shutdown should. The next test in this tree then found every model load
refused with ``ModelLoadInterruptedByShutdown`` before it started:
``test_hf_cache_repair`` failed after ``test_karaoke_ass`` and passed alone.
backend/tests/conftest.py had the reset (#1269); tests/conftest.py did not.

The pairs are deliberately order-dependent (pytest runs a file's tests in
definition order): the first test of each leaves exactly the state a lifespan
leaves, the second asserts it arrived clean. Remove the fixture and the second
test of each pair fails.
"""

import importlib
import os
import re
import sys

import services.model_manager as mm

_CONFTEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "conftest.py")


def test_dirty_the_shutdown_state():
    """Stand in for any lifespan-running test."""
    mm.begin_shutdown()
    mm._reset_gpu_pool()
    assert mm.is_shutting_down()


def test_next_test_starts_clean():
    assert not mm.is_shutting_down(), (
        "the shutdown flag leaked from the previous test: tests/conftest.py is "
        "not resetting it, so every model load in this test is refused as a "
        "shutdown-time load"
    )


# Bound by the test below to a SECOND copy of services.model_manager: the
# alias a tests/backend/** sys.modules purge strands in a test module.
stale_mm = None


def test_dirty_a_stale_module_alias():
    global stale_mm
    live = sys.modules.pop("services.model_manager")
    try:
        stale_mm = importlib.import_module("services.model_manager")
    finally:
        sys.modules["services.model_manager"] = live
        sys.modules["services"].model_manager = live
    assert stale_mm is not live
    stale_mm.begin_shutdown()
    assert stale_mm.is_shutting_down()


def test_stale_module_alias_starts_clean():
    assert stale_mm is not None, "the previous test did not run; check ordering"
    assert not stale_mm.is_shutting_down(), (
        "the shutdown flag leaked on a stale copy of services.model_manager: "
        "tests/conftest.py only cleans the module in sys.modules"
    )


def test_reset_failures_are_not_swallowed():
    """A reset inside ``except: pass`` would hand the next test stale state
    while looking like it worked."""
    with open(_CONFTEST, encoding="utf-8") as fh:
        src = fh.read()
    marker = "def _clean_model_manager_shutdown_state("
    assert marker in src, f"fixture renamed or removed from {_CONFTEST}"
    # The fixture's body ends at the next line that starts at column 0.
    body = re.split(r"\n(?=\S)", src.split(marker, 1)[1], maxsplit=1)[0]
    code = "\n".join(
        line for line in body.split('"""')[-1].splitlines()
        if not line.lstrip().startswith("#")
    )
    assert "except" not in code, code
