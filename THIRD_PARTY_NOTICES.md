# Third-party notices

This project is licensed under Apache 2.0 (see [LICENSE](LICENSE)). It
ships or bundles the third-party material below. Every item allows
commercial use.

## Files copied into this repository

**OpenTelemetry protocol definitions** (`server/proto/opentelemetry/`)

- Source: [opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto)
  v1.5.0, copied without changes.
- Copyright The OpenTelemetry Authors. Licensed under Apache 2.0; each file
  keeps its original header.

## Bundled into the web build

**IBM Plex Sans and IBM Plex Mono** fonts, through `@fontsource/ibm-plex-sans`
and `@fontsource/ibm-plex-mono` 5.3.0

- Copyright IBM Corp. Licensed under the SIL Open Font License 1.1.
- License texts: [licenses/ibm-plex-sans-OFL-1.1.txt](licenses/ibm-plex-sans-OFL-1.1.txt)
  and [licenses/ibm-plex-mono-OFL-1.1.txt](licenses/ibm-plex-mono-OFL-1.1.txt).

The web bundle also contains React, React DOM and React Router (MIT).

## Runtime dependencies (`npm ci --omit=dev`)

| Package | License |
|---|---|
| `hono`, `@hono/node-server` | MIT |
| `mongodb`, `bson`, `mongodb-connection-string-url` (MongoDB Node.js driver) | Apache 2.0 |
| `protobufjs` | BSD-3-Clause |
| `long` | Apache 2.0 |
| `@mongodb-js/saslprep`, `whatwg-url`, `tr46`, `punycode`, `memory-pager`, `sparse-bitfield` | MIT |
| `webidl-conversions` | BSD-2-Clause |

Each package carries its own license file in `node_modules`.

## Not part of this project

- **MongoDB server.** `docker-compose.yml` starts the official `mongo` image
  for local runs. The server is licensed by MongoDB, Inc. under the SSPL;
  this project only talks to it through the Apache 2.0 driver. In
  production, use the database your environment already runs.
- **Build tools** (Vite, TypeScript, Vitest, tsx and their dependencies) are
  only used to build and test. They are not part of the image.
