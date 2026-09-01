from .config import HOST, PORT


def main() -> None:
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(prog="devlog", description="Run the devlog backend.")
    parser.add_argument(
        "--host",
        default=HOST,
        help="Interface to bind. Use 0.0.0.0 to reach it from other devices "
        "(phone, tablet) on your network / Tailnet. "
        "Default: %(default)s (env DEVLOG_HOST).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=PORT,
        help="Port to listen on. Default: %(default)s (env DEVLOG_PORT).",
    )
    parser.add_argument(
        "--print-token",
        action="store_true",
        help="Print the access token (for logging in from another device) and exit.",
    )
    args = parser.parse_args()

    if args.print_token:
        from .auth import get_secret

        print(get_secret())
        return

    import os

    from .lock import acquire_datadir_lock

    # Record the actual bind host so the app can tell whether share links are
    # reachable from other devices (0.0.0.0 / a LAN IP) or localhost-only.
    os.environ["DEVLOG_BOUND_HOST"] = args.host

    acquire_datadir_lock(port=args.port)

    uvicorn.run("devlog.app:app", host=args.host, port=args.port, reload=False)
