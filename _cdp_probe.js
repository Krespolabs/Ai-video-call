// Throwaway: drive headless Chrome over CDP in *real* time (no virtual time),
// navigate to a URL, wait, then read an element's text out of the page.
// Usage: node _cdp_probe.js <url> <waitMs> <expression>

const [, , url, waitMs = "35000", expr = 'document.getElementById("result").textContent', actionExpr, actionDelayMs = "8000"] = process.argv;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let target;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("http://127.0.0.1:9222/json/list");
      const list = await res.json();
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {
      /* chrome still starting */
    }
    await sleep(500);
  }
  if (!target) throw new Error("no debuggable page target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === "Runtime.consoleAPICalled") {
      console.log("[console]", msg.params.args.map((a) => a.value ?? a.description).join(" "));
    } else if (msg.method === "Runtime.exceptionThrown") {
      console.log("[exception]", msg.params.exceptionDetails.text, msg.params.exceptionDetails.exception?.description ?? "");
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });
  console.log(`navigated to ${url}, waiting ${waitMs}ms real time...`);

  if (actionExpr) {
    await sleep(Number(actionDelayMs));
    console.log(`running action after ${actionDelayMs}ms: ${actionExpr}`);
    const act = await send("Runtime.evaluate", { expression: actionExpr, returnByValue: true, awaitPromise: false });
    console.log("action result:", JSON.stringify(act.result?.value ?? act));
    await sleep(Math.max(0, Number(waitMs) - Number(actionDelayMs)));
  } else {
    await sleep(Number(waitMs));
  }

  const out = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  console.log("---- result ----");
  console.log(out.result?.value ?? JSON.stringify(out));
  ws.close();
}

main().catch((err) => {
  console.error("CDP probe failed:", err.message);
  process.exit(1);
});
