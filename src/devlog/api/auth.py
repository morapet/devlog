"""Auth endpoints: token login → signed session cookie."""

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..auth import (
    SESSION_COOKIE,
    SESSION_TTL,
    auth_required_for,
    check_token,
    make_session,
    request_allowed,
)

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    token: str


@router.post("/login")
def login(body: LoginIn) -> JSONResponse:
    if not check_token(body.token):
        return JSONResponse({"detail": "invalid token"}, status_code=401)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        SESSION_COOKIE, make_session(),
        max_age=SESSION_TTL, httponly=True, samesite="lax", path="/",
    )
    return resp


@router.post("/logout")
def logout() -> Response:
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


@router.get("/status")
def status(request: Request) -> dict:
    host = request.client.host if request.client else None
    return {
        "required": auth_required_for(host),
        "authenticated": request_allowed(
            path="/__auth_probe__", client_host=host,
            cookies=request.cookies, headers=request.headers,
        ),
    }
