"""
Sidecar entry point.

Protocol with the parent (Electron) process:
  * stdout carries exactly one handshake line: `SIDECAR_READY {"port": 54321}`
    and nothing else. Recognized text NEVER goes to stdout.
  * stderr carries logs.
  * stdin is the lifeline: when the parent dies for any reason — including a
    Task Manager kill, where no shutdown handler runs — stdin hits EOF and this
    process exits, so nothing is left holding the audio device.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import threading


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.DEBUG if verbose else logging.INFO,
        format="[sidecar] %(levelname)s %(name)s: %(message)s",
    )
    # These are chatty and can echo prompts/text; keep them quiet.
    logging.getLogger("websockets").setLevel(logging.WARNING)


def _watch_stdin(on_eof) -> None:
    def run() -> None:
        try:
            while True:
                chunk = sys.stdin.readline()
                if chunk == "":
                    break
                if chunk.strip() == "shutdown":
                    break
        except Exception:  # noqa: BLE001
            pass
        on_eof()

    threading.Thread(target=run, name="stdin-watchdog", daemon=True).start()


def _default_models_dir() -> str:
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(appdata, "PrivateOverlay", "models")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="overlay-transcriber")
    parser.add_argument("--models-dir", default=os.environ.get("OVERLAY_MODELS_DIR") or _default_models_dir())
    parser.add_argument("--token-env", default="OVERLAY_SIDECAR_TOKEN")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--probe", action="store_true", help="print device/compute info and exit")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--quiet-latency",
        action="store_true",
        help="suppress the per-segment latency lines on stderr",
    )
    args = parser.parse_args(argv)

    _configure_logging(args.verbose)
    if args.quiet_latency:
        logging.getLogger("transcriber.latency").setLevel(logging.WARNING)
    log = logging.getLogger("transcriber")

    if args.list_devices:
        from .audio import list_devices

        print(json.dumps(list_devices(), indent=2))
        return 0

    if args.probe:
        from .audio import list_devices
        from .scribe_engine import probe as scribe_probe

        print(json.dumps({"elevenlabs": scribe_probe(), "audio": list_devices()}, indent=2))
        return 0

    token = os.environ.get(args.token_env, "")
    if not token:
        log.error("missing auth token in env var %s", args.token_env)
        return 2

    os.makedirs(args.models_dir, exist_ok=True)

    from .scribe_engine import API_KEY_ENV, api_key
    from .server import SidecarServer

    log.info(
        "recognition: ElevenLabs Scribe (%s)",
        "API key present" if api_key() else f"NO {API_KEY_ENV} SET",
    )

    server = SidecarServer(token=token, models_dir=args.models_dir)

    def on_ready(port: int) -> None:
        # The one and only stdout line.
        sys.stdout.write(f"SIDECAR_READY {json.dumps({'port': port})}\n")
        sys.stdout.flush()
        log.info("listening on 127.0.0.1:%d", port)

    _watch_stdin(server.request_shutdown)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, lambda *_: server.request_shutdown())
        except (ValueError, OSError):  # not available on all platforms/threads
            pass

    try:
        asyncio.run(server.serve(on_ready))
    except KeyboardInterrupt:
        pass
    finally:
        log.info("sidecar exiting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
