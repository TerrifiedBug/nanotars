// container/agent-runner/src/providers/index.ts
// Barrel: importing this file triggers all provider self-registrations.
// Each provider module's import has the side effect of `registerProvider(name, factory)`.
import './claude.js';
import './mock.js';
