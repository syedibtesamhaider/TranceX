"""
Package the sidecar with PyInstaller.

--onedir by default. Since recognition moved to the ElevenLabs API the bundle is
a fraction of its former size: no ctranslate2, no onnxruntime, no CUDA runtime
and no model weights, just audio capture and an HTTP client.

Usage:
    sidecar/.venv/Scripts/python.exe build.py [--onefile] [--clean]
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAME = "overlay-transcriber"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--onefile", action="store_true", help="single .exe (slow cold start)")
    parser.add_argument("--clean", action="store_true")
    args = parser.parse_args()

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("PyInstaller is not installed in this interpreter.", file=sys.stderr)
        print(
            "  sidecar\\.venv\\Scripts\\python.exe -m pip install -r sidecar/requirements-build.txt",
            file=sys.stderr,
        )
        return 2

    if args.clean:
        for folder in ("build", "dist"):
            shutil.rmtree(HERE / folder, ignore_errors=True)

    entry = HERE / "entry.py"
    entry.write_text(
        "from transcriber.__main__ import main\n"
        "import sys\n\n"
        "if __name__ == '__main__':\n"
        "    sys.exit(main())\n",
        encoding="utf-8",
    )

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--name",
        NAME,
        "--console",
        # stdout/stdin are the control channel with Electron; a windowed build
        # would have no usable stdio at all.
        "--onefile" if args.onefile else "--onedir",
        "--hidden-import",
        "pyaudiowpatch",
        "--hidden-import",
        "transcriber",
        "--exclude-module",
        "torch",
        "--exclude-module",
        "tkinter",
        "--exclude-module",
        "matplotlib",
        "--distpath",
        str(HERE / "dist"),
        "--workpath",
        str(HERE / "build"),
        "--specpath",
        str(HERE),
        str(entry),
    ]

    print("running:", " ".join(cmd))
    result = subprocess.run(cmd, cwd=HERE)
    entry.unlink(missing_ok=True)
    if result.returncode != 0:
        return result.returncode

    target = HERE / "dist" / (f"{NAME}.exe" if args.onefile else NAME)
    print(f"\nSidecar built: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
