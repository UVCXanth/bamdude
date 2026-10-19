"""Short-lived completion consumers own their resources until the last exit."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

_scopes: set[PrintCompletionTasks] = set()


class PrintCompletionTasks:
    def __init__(self, printer_id: int, *, timeout: float = 360):
        self.printer_id = printer_id
        self.tasks: set[asyncio.Task] = set()
        self._cleanup: Callable[[], None] | None = None
        self._closed = False
        self._timeout = timeout
        self._deadline: asyncio.TimerHandle | None = None
        _scopes.add(self)

    def add(self, task: asyncio.Task | None) -> None:
        # Test capture hooks can close the coroutine without returning a task.
        if isinstance(task, asyncio.Task):
            self.tasks.add(task)
            task.add_done_callback(self._done)

    def _done(self, task: asyncio.Task) -> None:
        self.tasks.discard(task)
        self._finish_if_done()

    def close(self, cleanup: Callable[[], None]) -> None:
        self._cleanup = cleanup
        self._closed = True
        if self.tasks:
            self._deadline = asyncio.get_running_loop().call_later(self._timeout, self._expire)
        self._finish_if_done()

    def _expire(self) -> None:
        logging.getLogger(__name__).warning(
            "Completion consumers exceeded their budget for printer %s; cancelling %s tasks",
            self.printer_id,
            len(self.tasks),
        )
        for task in tuple(self.tasks):
            task.cancel()

    def _finish_if_done(self) -> None:
        if self._closed and not self.tasks and self._cleanup is not None:
            cleanup, self._cleanup = self._cleanup, None
            if self._deadline is not None:
                self._deadline.cancel()
            try:
                cleanup()
            finally:
                _scopes.discard(self)


async def stop_print_completion_tasks(printer_id: int | None = None) -> None:
    """Cancel and drain this service's work before runtime/database teardown."""
    tasks = {task for scope in _scopes if printer_id is None or scope.printer_id == printer_id for task in scope.tasks}
    for task in tasks:
        task.cancel()
    if tasks:
        done, pending = await asyncio.wait(tasks, timeout=5)
        for task in done:
            if not task.cancelled():
                task.exception()
        for task in pending:
            task.cancel()
