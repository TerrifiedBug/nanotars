// container/agent-runner/src/providers/index.ts
// Barrel: importing this file triggers all provider self-registrations.
// Each provider module's import has the side effect of `registerProvider(name, factory)`.
//
// 5A-02 leaves this barrel empty; 5A-03 adds `./claude.js`, 5A-04 adds `./mock.js`.
