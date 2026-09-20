import { runDreamer, defaultDreamerSessionFactory } from "/Users/astrosheep/pi-extensions/pi-context/dist/src/dream/runner.js";
import { readFileSync } from "node:fs";
const playbook = "x"; // minimal — we only want the provider error
const spyFactory = async (opts) => {
  const session = await defaultDreamerSessionFactory(opts);
  const origSub = session.subscribe.bind(session);
  session.subscribe = (h) => origSub((e) => {
    if (e.type === "message_end") console.error("[spy] message_end role=", e.message?.role, "stopReason=", JSON.stringify(e.message?.stopReason), "errMsg=", (e.message?.errorMessage||"").slice(0,120));
    return h(e);
  });
  return session;
};
try { await runDreamer(playbook, process.argv[2], { modelPattern: "micu-ant/claude-fable-5", sessionFactory: spyFactory }); console.log("OK"); } catch (e) { console.error("THREW:", e.message.slice(0,200)); }
