from typing import Literal, Optional

from pydantic import BaseModel, Field, HttpUrl

TaskStatus = Literal["todo", "today", "doing", "blocked", "someday", "done", "cancelled"]
Priority = Literal["low", "normal", "high"]
Kind = Literal["task", "note", "link"]


class ProjectIn(BaseModel):
    slug: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    color: Optional[str] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None


class Project(BaseModel):
    id: int
    slug: str
    name: str
    description: Optional[str]
    color: Optional[str]
    created_at: str
    updated_at: str


class TaskCreate(BaseModel):
    project_id: int
    title: str = Field(min_length=1, max_length=500)
    body: Optional[str] = None
    tags: list[str] = []
    status: TaskStatus = "todo"
    due_at: Optional[str] = None
    priority: Optional[Priority] = None


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    tags: Optional[list[str]] = None
    status: Optional[TaskStatus] = None
    due_at: Optional[str] = None
    priority: Optional[Priority] = None
    blocked_reason: Optional[str] = None


class NoteCreate(BaseModel):
    project_id: int
    title: Optional[str] = None
    body: str = Field(min_length=1)
    tags: list[str] = []


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    tags: Optional[list[str]] = None


class LinkCreate(BaseModel):
    project_id: int
    url: HttpUrl
    title: Optional[str] = None
    annotation: Optional[str] = None
    tags: list[str] = []
    is_read: bool = False
    fetch_metadata: bool = True


class LinkUpdate(BaseModel):
    title: Optional[str] = None
    annotation: Optional[str] = None
    tags: Optional[list[str]] = None
    is_read: Optional[bool] = None
    is_pinned: Optional[bool] = None


class Item(BaseModel):
    id: int
    kind: Kind
    project_id: int
    title: Optional[str]
    body: Optional[str]
    tags: list[str]
    created_at: str
    updated_at: str
    # task
    status: Optional[TaskStatus] = None
    due_at: Optional[str] = None
    priority: Optional[Priority] = None
    blocked_reason: Optional[str] = None
    done_at: Optional[str] = None
    doing_started_at: Optional[str] = None
    # link
    url: Optional[str] = None
    link_description: Optional[str] = None
    favicon_url: Optional[str] = None
    is_read: bool = False
    is_pinned: bool = False
    # populated on detail
    backlinks: list[int] = []
    refs_out: list[int] = []
