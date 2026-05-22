from .config import HOST, PORT


def main() -> None:
    import uvicorn

    uvicorn.run("devlog.app:app", host=HOST, port=PORT, reload=False)
