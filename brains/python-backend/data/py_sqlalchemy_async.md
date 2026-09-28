---
id: py_sqlalchemy_async
title: SQLAlchemy 2.0 Async Sessions
criteria: SQLAlchemy 2.0 with asyncio - create_async_engine, async_sessionmaker, one session per request, select() queries, Mapped models, eager loading, MissingGreenlet errors
---

# SQLAlchemy 2.0 Async Sessions

## Engine and sessions
One engine per process, created at startup and disposed at shutdown; one
session per request (or per unit of work), never shared between tasks.

```python
engine = create_async_engine(settings.database_url, pool_pre_ping=True)  # postgresql+asyncpg://...
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
```

`expire_on_commit=False` matters in async code: after a commit the default
expires every loaded attribute, and the next attribute access would need an
implicit query, which async sessions cannot run.

## Models
```python
class Base(DeclarativeBase):
    pass

class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(unique=True)
    orders: Mapped[list["Order"]] = relationship(back_populates="user")
```

## Queries (2.0 style)
```python
user = await session.get(User, user_id)
users = (await session.scalars(select(User).where(User.is_active))).all()
count = await session.scalar(select(func.count()).select_from(User))
```
`session.query(...)` is the legacy 1.x API; do not use it in new code.

## Relationships: load them explicitly
Lazy loading does not work with an async session. Touching an unloaded
relationship raises `MissingGreenlet` ("greenlet_spawn has not been called").
Load what you need in the query:

```python
stmt = select(User).options(selectinload(User.orders)).where(User.id == user_id)
```
- `selectinload` for collections, `joinedload` for many-to-one.
- `relationship(lazy="raise")` turns accidental lazy loads into clear errors.

## Transactions
```python
async with session.begin():   # commits on success, rolls back on error
    session.add(order)
```
Or call `await session.commit()` yourself, once, at the end of the unit of work.
Do not commit inside helper functions; the caller owns the transaction.

## Pool sizing
`pool_size` + `max_overflow`, times the number of processes, must stay below
PostgreSQL's `max_connections` (minus admin headroom). Behind PgBouncer in
transaction mode, disable asyncpg's prepared-statement cache, or queries fail
with "prepared statement already exists".
