"""Finds the Extension Test Host window by owning PID and captures it.

Usage: capture.py <user-data-dir> <output-png-path>

Prints one JSON line to stdout: {"ok": true, "name": ..., "bounds": {...}}
on success, or {"ok": false, "error": "..."} on failure. Requires macOS
Screen Recording permission granted to the calling process (see README.md).
"""
import json
import subprocess
import sys


def fail(message):
    print(json.dumps({'ok': False, 'error': message}))
    sys.exit(1)


def main():
    if len(sys.argv) != 3:
        fail('usage: capture.py <user-data-dir> <output-png-path>')
    user_data_dir, out_path = sys.argv[1], sys.argv[2]

    try:
        import Quartz
    except ImportError as error:
        fail(f'pyobjc Quartz is not importable: {error}')
        return

    pgrep = subprocess.run(
        ['pgrep', '-f', f'user-data-dir={user_data_dir}'],
        capture_output=True, text=True,
    )
    pids = {int(pid) for pid in pgrep.stdout.split()}
    if not pids:
        fail(f'no running process matches user-data-dir={user_data_dir}')

    windows = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    mine = [
        window for window in windows
        if window.get('kCGWindowOwnerPID') in pids and window.get('kCGWindowLayer', 0) == 0
    ]
    if not mine:
        # A window that exists but is not on the current macOS Space (e.g. another VS Code
        # session has focus) is deliberately not captured here: screencapture would grab a
        # stale, frozen frame instead of live content, which is worse than a clear failure.
        fail(f'no on-screen windows owned by pid(s) {sorted(pids)}')

    biggest = max(mine, key=lambda w: w['kCGWindowBounds']['Width'] * w['kCGWindowBounds']['Height'])
    result = subprocess.run(
        ['screencapture', '-x', '-o', '-l', str(biggest['kCGWindowNumber']), out_path],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        fail(f'screencapture exited {result.returncode}: {result.stderr.strip()}')

    print(json.dumps({
        'ok': True,
        'name': biggest.get('kCGWindowName'),
        'bounds': dict(biggest['kCGWindowBounds']),
    }))


if __name__ == '__main__':
    main()
