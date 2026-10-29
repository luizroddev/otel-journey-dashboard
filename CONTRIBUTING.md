# Contributing

## Fictional data only

This dashboard is generic. Nothing in this repository (code, fixtures,
screenshots, docs, issues, pull requests, commit messages) may contain data
or details of a real app, company, user or device:

- Examples use the fictional `demo-shop` (login, catalog, cart, payment) and
  ids like `demo-device-1` / `demo-user-1`.
- Screenshots come from `npm run seed` data.
- No real endpoints, header names, internal service names, documents or
  business rules of any company.

If a change needs knowledge of a specific environment, keep that knowledge
in that environment's own repository and contribute only the generic part
here (an option, an extension point, a contract change).

## Changes to the contracts

`docs/storage-schema.md` and `docs/query-api.md` are what other services
implement. Change them together with the code, keep `npm run conformance`
in sync, and note the change in the pull request.

## Checks

```bash
docker compose up -d mongo
MONGO_URL=mongodb://localhost:27017 npm test
npm run typecheck
npm run build
```
