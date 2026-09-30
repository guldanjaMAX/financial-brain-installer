#!/usr/bin/env python3
"""Exercise question, hidden entry, question on a bounded pseudo-terminal."""

import errno
import json
import os
import pty
import re
import select
import signal
import sys
import time


SYNTHETIC_KEY = b"K7" + (b"q" * 36) + b"Z9"


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: hidden-entry-pty.py node child.mjs")
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.execvpe(sys.argv[1], [sys.argv[1], sys.argv[2]], os.environ)

    screen = b""
    cursor = 0
    decision_points = 0
    steps = [
        (b"Use recovery access? (y/n)", b"y\r"),
        (b"Cloudflare token (hidden):", SYNTHETIC_KEY + b"\r"),
        (b"Continue? (y/n)", b"n\r"),
    ]
    status = None
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master_fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(master_fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            screen += chunk
        if steps:
            marker, answer = steps[0]
            found = screen.find(marker, cursor)
            if found >= 0:
                cursor = found + len(marker)
                os.write(master_fd, answer)
                decision_points += 1
                steps.pop(0)
        waited, candidate = os.waitpid(child_pid, os.WNOHANG)
        if waited == child_pid:
            status = candidate
            break

    if status is None:
        os.kill(child_pid, signal.SIGTERM)
        _, status = os.waitpid(child_pid, 0)
    match = re.search(rb"PTY_RESULT (\{[^\r\n]+\})", screen)
    result = json.loads(match.group(1)) if match else None
    receipt = {
        "decisionPoints": decision_points,
        "keyVisible": SYNTHETIC_KEY in screen,
        "exited": os.waitstatus_to_exitcode(status) == 0,
        "result": result,
    }
    print(json.dumps(receipt, separators=(",", ":")))
    return 0 if receipt["exited"] and result is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
