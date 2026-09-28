#!/usr/bin/env node
// Launcher: registers tsx so the TypeScript CLI runs with plain `node`, from any
// working directory - which is what an MCP client or a global bin link needs.
import { register } from "tsx/esm/api";

register();
await import("./brain-traverse.ts");
