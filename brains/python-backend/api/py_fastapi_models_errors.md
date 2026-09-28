---
id: py_fastapi_models_errors
title: Pydantic Models and API Errors
criteria: Pydantic v2 request and response schemas, field validators, response_model filtering, partial PATCH updates, HTTPException, 422 validation errors and custom exception handlers
---

# Pydantic Models and API Errors

## Separate schemas per direction
Use distinct models for input and output so clients cannot set server-owned
fields and responses never leak internals (password hashes, soft-delete flags).

```python
class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12)

class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)  # read from ORM objects
    id: int
    email: EmailStr
```

Declaring the return type (`-> UserRead`) or `response_model=UserRead` makes
FastAPI validate and filter the output.

## Pydantic v2 names
| v1 | v2 |
|---|---|
| `class Config: orm_mode = True` | `model_config = ConfigDict(from_attributes=True)` |
| `.dict()`, `.json()` | `.model_dump()`, `.model_dump_json()` |
| `parse_obj()` | `model_validate()` |
| `@validator`, `@root_validator` | `@field_validator`, `@model_validator` |

```python
@field_validator("email")
@classmethod
def lower(cls, value: str) -> str:
    return value.lower()
```

## PATCH
Apply only the fields the client sent:

```python
changes = payload.model_dump(exclude_unset=True)
for field, value in changes.items():
    setattr(user, field, value)
```
Make every field of the update model optional; `exclude_unset` tells an
omitted field apart from an explicit `null`.

## Errors
- Raise `HTTPException(status_code=404, detail="User not found")` from handlers
  or dependencies. It is not an error in your logs; it is a response.
- Invalid input returns **422** with a list of field errors, raised as
  `RequestValidationError`. Override its handler only to reshape the body, and
  keep the field locations.
- Map domain exceptions to status codes in one place instead of catching them
  in every route:

```python
@app.exception_handler(NotFound)
async def not_found(request: Request, exc: NotFound):
    return JSONResponse(status_code=404, content={"detail": str(exc)})
```

- Never return stack traces or SQL errors to the client; log them with the
  request id and return a generic 500.
