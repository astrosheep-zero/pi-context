# SDK integration

SDK hosts that create a session directly can bind pi-context to the exact same public `SettingsManager` authority as the session:

```ts
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPiContext } from "@astrosheep/pi-context";

const cwd = process.cwd();
const agentDir = "/tmp/my-pi-agent";
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: true, reserveTokens: 16_384 },
});
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  extensionFactories: [createPiContext({ settingsManager })],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd,
  agentDir,
  settingsManager,
  resourceLoader,
});
```

The root entry exports only the default Pi extension and `createPiContext`. This is a breaking source/API refactor: `NotesContext` is replaced by `NotesIdentity`; old internal export bags, root history helpers and the `./dist/src/index.js` export alias are removed. Import the root for Pi integration and `/notes` for the standalone library. The configured dream executable is now `dist/src/pi/dream/cli.js`. Stored notes, session paths, metadata and raw histories are unchanged; no migration runs.

The manager must be shared by the resource loader's factory and `createAgentSession`. If the host replaces its settings authority, it must create and bind a new `createPiContext({ settingsManager })` factory together with the replacement manager; an existing factory remains bound to the manager it was created with.

The default extension export is file-backed: it reads Pi's standard global settings directory plus the trusted project's `.pi/settings.json`, with project values winning per key. It cannot discover an arbitrary SDK session manager from `cwd`, environment variables, session IDs, or private SDK fields. For an injected manager, compaction settings come from the manager's public `getCompactionSettings(model)` getter, including the active model's `modelOverrides`; pi-context margins are read from the public `getGlobalSettings()` and `getProjectSettings()` scopes. Opaque runtime overrides that those public scope getters do not expose are intentionally not treated as pi-context configuration. Live public manager changes apply on the next policy query/turn, and the extension does not drain the manager's settings I/O diagnostics.
