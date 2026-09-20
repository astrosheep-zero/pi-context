import { runDreamer, defaultDreamerSessionFactory, READ_ONLY_TOOLS } from "/Users/astrosheep/pi-extensions/pi-context/dist/src/dream/runner.js";
import { readFileSync } from "node:fs";
const playbook = readFileSync("/Users/astrosheep/pi-extensions/pi-context/playbook.md", "utf8");
const spyFactory = async (opts) => {
  console.error("[spy] tools:", opts.tools.join(","), "modelPattern:", opts.modelPattern);
  const session = await defaultDreamerSessionFactory(opts);
  const origSub = session.subscribe.bind(session);
  session.subscribe = (h) => origSub((e) => {
    if (e.type === "message_end") console.error("[spy] event message_end role=", e.message?.role, "content=", JSON.stringify(e.message?.content).slice(0, 2000));
    if (e.type !== "message_end") console.error("[spy] event:", e.type);
    return h(e);
  });
  return session;
};
try {
  const m = await runDreamer(playbook, process.argv[2], { modelPattern: "micu-ant/claude-fable-5", sessionFactory: spyFactory });
  console.log("MANIFEST OK:", JSON.stringify(m).slice(0, 500));
} catch (e) { console.error("FAILED:", e.message); }
