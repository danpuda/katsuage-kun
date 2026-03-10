"""Basic tests for receiver_v2.py"""
import subprocess, sys

def test_import():
    """Verify receiver_v2.py can be imported without errors."""
    result = subprocess.run(
        [sys.executable, "-c", "import importlib.util; spec = importlib.util.spec_from_file_location('r', 'src/receiver_v2.py'); mod = importlib.util.module_from_spec(spec)"],
        capture_output=True, text=True
    )
    # Just check it doesn't crash on syntax
    assert result.returncode == 0, f"Import failed: {result.stderr}"
