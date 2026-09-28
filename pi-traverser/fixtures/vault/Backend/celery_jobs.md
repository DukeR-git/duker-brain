---
id: celery_jobs
title: Background Jobs
criteria: Celery workers and tasks, task retries and backoff, idempotent side effects, scheduling periodic jobs, message brokers
---

# Background Jobs

## Task design
Tasks take primitives, not ORM objects: the worker deserialises in another
process and a detached instance is not portable. Pass an id and re-fetch.

## Retries
`autoretry_for` with `retry_backoff` handles transient failures. Set
`max_retries` explicitly; the default retries a permanent failure forever.

## Idempotency
A broker guarantees at-least-once delivery, so a task can run twice. Make the
side effect idempotent or guard it with a unique constraint.
