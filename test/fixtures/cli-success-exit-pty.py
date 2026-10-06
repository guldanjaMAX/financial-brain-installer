#!/usr/bin/env python3
"""Run one child on a bounded pseudo-terminal and forward its output."""

import errno
import os
import pty
import select
import signal
import sys
import time


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("usage: cli-success-exit-pty.py command [args...]")
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

    # The parent test passes its per-arm budget so the two timers cannot drift.
    deadline = time.monotonic() + float(os.environ.get("CLI_EXIT_PTY_SECONDS", "20"))
    status = None
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master_fd], [], [], 0.05)
        if ready:
            try:
                data = os.read(master_fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if data:
                os.write(sys.stdout.fileno(), data)
        waited, candidate = os.waitpid(child_pid, os.WNOHANG)
        if waited == child_pid:
            status = candidate
            break

    if status is None:
        os.kill(child_pid, signal.SIGTERM)
        _, status = os.waitpid(child_pid, 0)
        print("PTY_TIMEOUT", flush=True)
        return 124
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    raise SystemExit(main())
