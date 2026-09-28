---
id: py_fastapi_auth
title: FastAPI Authentication and Security
criteria: Authenticating API requests - OAuth2 bearer tokens, JWT signing and verification, password hashing, API keys, current-user dependencies, CORS settings
---

# FastAPI Authentication and Security

## Bearer tokens
`OAuth2PasswordBearer` only extracts the token from the `Authorization` header;
verifying it is your job. Chain dependencies so each route asks for exactly
what it needs:

```python
oauth2 = OAuth2PasswordBearer(tokenUrl="auth/token")

async def current_user(token: Annotated[str, Depends(oauth2)], session: SessionDep) -> User:
    try:
        claims = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token", headers={"WWW-Authenticate": "Bearer"})
    user = await session.get(User, int(claims["sub"]))
    if user is None or not user.is_active:
        raise HTTPException(401, "Invalid token", headers={"WWW-Authenticate": "Bearer"})
    return user

CurrentUser = Annotated[User, Depends(current_user)]
```

## JWT rules
- Always pass `algorithms=[...]` explicitly when decoding (PyJWT requires it);
  never accept whatever algorithm the token header names.
- Keep tokens short-lived (minutes) and put only an id in `sub`, not roles you
  would need to revoke. Check roles against the database.
- The secret comes from settings, is long and random, and differs per environment.

## Passwords
Hash with argon2 (argon2-cffi, or pwdlib) or bcrypt. passlib has not had a
release in years and breaks with recent bcrypt versions. Never log passwords or
tokens, and compare secrets with `secrets.compare_digest`, not `==`.

## API keys for machine clients
Store only a hash of each key, look it up by a non-secret prefix, and compare
the hash in constant time. Send keys in a header (`X-API-Key`), never a query
string, which ends up in access logs.

## Authorisation
Authentication says who; authorisation says whether. Check ownership in the
service layer (`order.owner_id == user.id`), not only in the router. Returning
404 rather than 403 for other users' objects keeps ids from being probed.

## CORS
List exact origins in `CORSMiddleware(allow_origins=[...])`. Browsers reject a
`*` origin on requests with credentials, and `*` plus cookies is never what you
want. CORS is not access control: it does not stop non-browser clients.
