"""
Local WebSocket server.

Binds 127.0.0.1 on a random free port. The port is handed to the parent process
over stdout; the shared secret arrives through an environment variable, never
argv — command lines are readable by any process on Windows, and without a token
any local program could connect and read the meeting transcript.

Recognized text is only ever sent over this socket. It is never logged, printed
to stdout, or written to disk.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
from typing import Any

import websockets

from .pipeline import Pipeline

log = logging.getLogger("transcriber.server")

AUTH_TIMEOUT_S = 5.0
CLOSE_POLICY_VIOLATION = 1008


class SidecarServer:
    def __init__(self, token: str, models_dir: str, host: str = "127.0.0.1"):
        self._token = token
        self._host = host
        self._clients: set[Any] = set()
        self._queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=2048)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._shutdown = asyncio.Event()
        self.pipeline = Pipeline(self._emit_threadsafe, models_dir)
        self.port = 0

    # -- lifecycle ------------------------------------------------------------

    async def serve(self, on_ready) -> None:
        self._loop = asyncio.get_running_loop()
        async with websockets.serve(
            self._handle,
            self._host,
            0,
            ping_interval=20,
            ping_timeout=20,
            max_queue=64,
        ) as server:
            self.port = server.sockets[0].getsockname()[1]
            on_ready(self.port)
            broadcaster = asyncio.create_task(self._broadcast_loop())
            try:
                await self._shutdown.wait()
            finally:
                broadcaster.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await broadcaster
        self.pipeline.shutdown()

    def request_shutdown(self) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._shutdown.set)

    # -- event fan-out --------------------------------------------------------

    def _emit_threadsafe(self, event: dict) -> None:
        """Called from pipeline threads."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(self._enqueue, event)

    def _enqueue(self, event: dict) -> None:
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            log.warning("event queue full; dropping %s", event.get("type"))

    async def _broadcast_loop(self) -> None:
        while True:
            event = await self._queue.get()
            if not self._clients:
                continue
            payload = json.dumps(event, ensure_ascii=False)
            dead = []
            for client in list(self._clients):
                try:
                    await client.send(payload)
                except Exception:  # noqa: BLE001
                    dead.append(client)
            for client in dead:
                self._clients.discard(client)

    # -- connection handling --------------------------------------------------

    async def _handle(self, websocket, *_args) -> None:
        try:
            raw = await asyncio.wait_for(websocket.recv(), timeout=AUTH_TIMEOUT_S)
            message = json.loads(raw)
            if message.get("type") != "auth" or not secrets.compare_digest(
                str(message.get("token", "")), self._token
            ):
                await websocket.close(CLOSE_POLICY_VIOLATION, "unauthorized")
                return
        except (asyncio.TimeoutError, json.JSONDecodeError, Exception):
            with contextlib.suppress(Exception):
                await websocket.close(CLOSE_POLICY_VIOLATION, "unauthorized")
            return

        self._clients.add(websocket)
        await self._send(websocket, {"type": "ready", **self.pipeline.describe()})

        try:
            async for raw in websocket:
                await self._on_message(websocket, raw)
        except Exception:  # noqa: BLE001 - normal disconnects land here too
            pass
        finally:
            self._clients.discard(websocket)
            if not self._clients:
                # Release the audio device when the app goes away.
                await asyncio.to_thread(self.pipeline.stop)

    async def _send(self, websocket, event: dict) -> None:
        with contextlib.suppress(Exception):
            await websocket.send(json.dumps(event, ensure_ascii=False))

    async def _on_message(self, websocket, raw: str) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            return

        kind = message.get("type")
        if kind == "start":
            await asyncio.to_thread(self.pipeline.start)
        elif kind == "stop":
            await asyncio.to_thread(self.pipeline.stop)
        elif kind == "config":
            await asyncio.to_thread(
                self.pipeline.apply_config,
                message.get("language"),
                message.get("model"),
                message.get("tuning"),
            )
        elif kind == "state":
            await self._send(websocket, {"type": "state", **self.pipeline.describe()})
        elif kind == "ping":
            await self._send(websocket, {"type": "pong"})
        elif kind == "shutdown":
            self.request_shutdown()
