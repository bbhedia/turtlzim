// minimal CDP client for an Android WebView page
export async function connect(port = 9222) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); } else events.push(d); };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "exception"); return r.result.value; };
  return { send, evaluate, events, url: target.url, close: () => ws.close() };
}
