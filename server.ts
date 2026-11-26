#!/usr/bin/env bun
// The relay: `bun server.ts`, bound to 127.0.0.1 (scripts/install-service.sh runs it as a systemd user unit).
import { batonHome, batonPort } from './src/config.ts';
import { VERSION, startServer } from './src/server.ts';

const { port } = startServer({ port: batonPort(), home: batonHome() });
console.log(`baton ${VERSION} listening on http://localhost:${port} (state in ${batonHome()})`);
