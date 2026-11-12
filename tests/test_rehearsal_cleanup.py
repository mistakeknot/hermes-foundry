"""Offline lifecycle tests; every deletion target belongs to this test's tmp_path."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/rehearsal/rehearse.py"


@pytest.fixture(autouse=True)
def restore_tempdir(monkeypatch):
    # init_run redirects tempfile globally; do not leak that into other test modules.
    monkeypatch.setattr(tempfile, "tempdir", tempfile.tempdir)


def harness():
    spec = importlib.util.spec_from_file_location("rehearse", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_partial_home_without_marker_is_removed(tmp_path, monkeypatch):
    rh = harness()
    monkeypatch.setenv("FOUNDRY_REHEARSAL_BASE", str(tmp_path))
    rh.init_run(need_src=False)
    monkeypatch.setattr(rh, "free_port", lambda: (_ for _ in ()).throw(RuntimeError("setup failed")))
    with pytest.raises(RuntimeError, match="setup failed"):
        rh.up()
    assert not list(Path(rh.RH_ROOT).iterdir())
    rh.RUN_CLEANUP.at_exit()


@pytest.mark.parametrize("ending", ["pass", "error", "timeout", "wrapper", "SIGINT", "SIGTERM", "SIGHUP"])
def test_exit_fallback(tmp_path, ending):
    code = f"""
import importlib.util, os, signal, subprocess, time
s = importlib.util.spec_from_file_location('rh', {str(SCRIPT)!r})
rh = importlib.util.module_from_spec(s); s.loader.exec_module(rh)
for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP): signal.signal(sig, rh._term)
rh.init_run(need_src=False)
os.mkdir(os.path.join(rh.RH_ROOT, 'foundry-rh.partial'))
ending = {ending!r}
if ending.startswith('SIG'): os.kill(os.getpid(), getattr(signal, ending))
if ending == 'error': raise RuntimeError('injected failure')
if ending == 'timeout': raise subprocess.TimeoutExpired('probe', 1)
if ending == 'wrapper': time.sleep(30)
"""
    cmd = [sys.executable, "-c", code]
    if ending == "wrapper":
        cmd = ["timeout", "--signal=TERM", "1"] + cmd
    p = subprocess.run(cmd, env=dict(os.environ, FOUNDRY_REHEARSAL_BASE=str(tmp_path)),
                       capture_output=True, text=True, timeout=10)
    assert (p.returncode == 0) == (ending == "pass"), p.stderr
    run = next(tmp_path.glob("foundry-rh-run.*"))
    assert not (run / "homes").exists()
    assert (run / "out").is_dir()


def test_stale_sweep_is_confined_and_skips_live_keep_and_unknown(tmp_path, monkeypatch):
    rh = harness()
    monkeypatch.setenv("FOUNDRY_REHEARSAL_BASE", str(tmp_path))
    rh.init_run(need_src=False)
    stale = Path(rh.RUN)
    (stale / "homes" / "foundry-rh.partial").mkdir()
    # Simulate a crashed harness: release its lock without running its exit callback.
    rh.RUN_CLEANUP.close()
    unknown = tmp_path / "foundry-rh-run.unknown"
    (unknown / "homes").mkdir(parents=True)
    outside = tmp_path / "unrelated"
    outside.mkdir()
    (outside / "precious").write_text("keep")
    (tmp_path / "foundry-rh-run.link").symlink_to(outside, target_is_directory=True)
    rh.init_run(need_src=False, keep=True)
    kept = Path(rh.RUN)
    rh.RUN_CLEANUP.close()
    rh.init_run(need_src=False)
    live = Path(rh.RUN)
    active = rh.RUN_CLEANUP
    rh.init_run(need_src=False)
    assert not (stale / "homes").exists()
    assert (stale / "out").exists()
    assert (unknown / "homes").exists()
    assert (kept / "homes").exists()
    assert (live / "homes").exists()
    assert (outside / "precious").read_text() == "keep"
    active.close()


def test_sweep_refuses_foreign_owner_and_newer_run(tmp_path, monkeypatch):
    rh = harness()
    monkeypatch.setenv("FOUNDRY_REHEARSAL_BASE", str(tmp_path))
    rh.init_run(need_src=False)
    run = Path(rh.RUN)
    rh.RUN_CLEANUP.close()
    rh.sweep_stale(str(tmp_path), 0)
    assert (run / "homes").exists()
    uid = os.getuid()
    with monkeypatch.context() as m:
        m.setattr(rh.os, "getuid", lambda: uid + 1)
        rh.sweep_stale(str(tmp_path), rh.time.time_ns())
    assert (run / "homes").exists()
    rh.sweep_stale(str(tmp_path), rh.time.time_ns())
    assert not (run / "homes").exists()


@pytest.mark.parametrize("link", ["homes", ".foundry-rh-run"])
def test_sweep_does_not_follow_symlinks(tmp_path, monkeypatch, link):
    rh = harness()
    monkeypatch.setenv("FOUNDRY_REHEARSAL_BASE", str(tmp_path))
    rh.init_run(need_src=False)
    run = Path(rh.RUN)
    rh.RUN_CLEANUP.close()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "precious").write_text("keep")
    target = run / link
    if target.is_dir():
        target.rmdir()
    else:
        target.unlink()
    target.symlink_to(outside, target_is_directory=True)
    rh.sweep_stale(str(tmp_path), rh.time.time_ns())
    assert target.is_symlink()
    assert (outside / "precious").read_text() == "keep"


def test_sweep_retains_home_with_surviving_child(tmp_path, monkeypatch):
    rh = harness()
    monkeypatch.setenv("FOUNDRY_REHEARSAL_BASE", str(tmp_path))
    rh.init_run(need_src=False)
    run = Path(rh.RUN)
    rh.RUN_CLEANUP.close()
    child = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"],
                             stdin=subprocess.PIPE,
                             env=dict(os.environ, HERMES_HOME=str(run / "homes" / "foundry-rh.child")))
    try:
        rh.sweep_stale(str(tmp_path), rh.time.time_ns())
        assert (run / "homes").exists()
    finally:
        child.communicate(timeout=5)
    rh.sweep_stale(str(tmp_path), rh.time.time_ns())
    assert not (run / "homes").exists()


@pytest.mark.parametrize("data", ["[]", "null", "{", '{"version":1,"keep":"no"}'])
def test_sweep_skips_invalid_marker(tmp_path, monkeypatch, data):
    rh = harness()
    monkeypatch.setenv("FOUNDRY_REHEARSAL_BASE", str(tmp_path))
    rh.init_run(need_src=False)
    run = Path(rh.RUN)
    rh.RUN_CLEANUP.close()
    (run / rh.RunCleanup.MARKER).write_text(data)
    rh.sweep_stale(str(tmp_path), rh.time.time_ns())
    assert (run / "homes").exists()
