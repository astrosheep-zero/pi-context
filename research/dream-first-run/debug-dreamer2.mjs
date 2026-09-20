import { runDreamer, defaultDreamerSessionFactory } from "/Users/astrosheep/pi-extensions/pi-context/dist/src/dream/runner.js";
import { readFileSync } from "node:fs";
const playbook = readFileSync("/Users/astrosheep/pi-extensions/pi-context/playbook.md", "utf8");
const spyFactory = async (opts) => {
  const session = await defaultDreamerSessionFactory(opts);
  const origSub = session.subscribe.bind(session);
  session.subscribe = (h) => origSub((e) => {
    if (["turn_end","agent_end","agent_settled","error","message_error"].includes(e.type)) console.error("[spy]", e.type, JSON.stringify(e).slice(0, 1500));
    return h(e);
  });
  return session;
};
try {
  const m = await runDreamer(playbook, process.argv[2], { modelPattern: "micu-ant/claude-fable-5", sessionFactory: spyFactory });
  console.log("MANIFEST OK:", JSON.stringify(m).slice(0, 300));
} catch (e) { console.error("FAILED:", e.message); }
