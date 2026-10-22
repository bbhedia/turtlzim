// What the server does under load, measured: it is started as a program on a data folder of its own (never the live one), and driven over HTTP by virtual people who each sign up, sign in, and keep a
// notebook in step the way the app does (the manifest, the files that changed, the files that are read). Each has an address of their own (the server is told to trust the proxy header, as it is behind one),
// so what is measured is what many people do and not the limit on what one address may try. The numbers go in docs/zim-operations.md; run it again after a change that could make the server slower.
//
//   node scripts/load.mjs [--users 20] [--files 60] [--bytes 2000] [--seconds 20] [--think 50] [--storm 0] [--ramp 16] [--json]
//
// users: how many people; files and bytes: what each one's notebook holds; seconds: how long the steady part lasts; think: the pause, in ms, between one person's requests;
// ramp: how many sign up (and sign in) at the same time at the start (a crowd arrives over time, and the server hashes only so many passwords at once and turns away the ones beyond the queue: ZIM_HASH_SLOTS and
// ZIM_HASH_QUEUE, which this tool leaves as they are in its environment); the storm is the deliberate burst;
// storm: that many sign-in attempts, each from an address of its own with an e-mail address of its own, all at once a third of the way through the steady part (the cost of a password is paid
// whether it is right or not, so this is what a crowd of strangers does to a server): the report says what it did to the people who were only keeping their notebooks in step.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const PASSWORD = "correct horse battery";

function options(argv) {
  const given = { users: 20, files: 60, bytes: 2000, seconds: 20, think: 50, storm: 0, ramp: 16, json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") given.json = true;
    else if (["--users", "--files", "--bytes", "--seconds", "--think", "--storm", "--ramp"].includes(flag)) {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} needs a number`);
      given[flag.slice(2)] = value;
    } else throw new Error(`unknown option ${flag}`);
  }
  if (given.users < 1) throw new Error("at least one person");
  if (given.ramp < 1) throw new Error("--ramp needs at least one at a time");
  return given;
}

/** Run `work` for every item, `size` at a time (a window that moves: one that is done makes room for the next). */
async function pooled(items, size, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await work(items[i]);
    }),
  );
}

const percentile = (sorted, p) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);

/** Seconds of processor that a process has used, from the system (user + system time). */
function cpuSeconds(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ");
    return (Number(fields[11]) + Number(fields[12])) / 100;
  } catch {
    return 0;
  }
}
function peakMemoryMiB(pid) {
  try {
    return Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024;
  } catch {
    return 0;
  }
}

async function main() {
  const o = options(process.argv.slice(2));
  const data = mkdtempSync(join(tmpdir(), "zim-load-"));
  const child = spawn(process.execPath, [join(root, "src/main.mjs"), "--host", "127.0.0.1", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ZIM_SERVER_DATA: data, ZIM_BASE_URL: "http://127.0.0.1", ZIM_TRUST_PROXY: "1" },
  });
  let said = "";
  child.stdout.on("data", (chunk) => (said += chunk));
  child.stderr.on("data", (chunk) => (said += chunk));
  const stop = () => child.kill("SIGKILL");
  process.on("exit", stop);
  let base = "";
  for (let waited = 0; !base; waited += 50) {
    base = /http:\/\/127\.0\.0\.1:\d+/.exec(said)?.[0] ?? "";
    if (child.exitCode !== null) throw new Error(`the server ended: ${said}`);
    if (waited > 20_000) throw new Error(`the server did not start: ${said}`);
    if (!base) await sleep(50);
  }

  // --- what is measured ---
  const times = new Map();
  /** For the steady part: when each request began (ms from the start of the run) and how long it took, to say what a storm did to it. */
  const steadyLog = [];
  let logging = false;
  const failures = new Map();
  /** What the first failure of each kind of request was (a failing run says why). */
  const firstFailures = new Map();
  const note = (name, ms, ok, why) => {
    if (!times.has(name)) times.set(name, []);
    times.get(name).push(ms);
    if (!ok) {
      failures.set(name, (failures.get(name) ?? 0) + 1);
      if (!firstFailures.has(name)) firstFailures.set(name, why);
    }
  };
  const people = Array.from({ length: o.users }, (_, i) => ({ i, email: `load${i}@example.org`, address: `10.${(i >> 8) & 255}.${i & 255}.7`, cookie: "", id: `notebook-${i}-${randomBytes(4).toString("hex")}`, revision: 0, names: [] }));
  const call = async (person, name, method, path, body) => {
    const started = performance.now();
    let status = 0;
    let json = null;
    try {
      const response = await fetch(base + path, {
        method,
        headers: { "x-forwarded-for": person.address, "x-requested-with": "zim", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(person.cookie ? { cookie: person.cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      status = response.status;
      const set = response.headers.get("set-cookie");
      if (set && !set.split(";")[0].endsWith("=")) person.cookie = set.split(";")[0];
      json = await response.json().catch(() => null);
    } catch (error) {
      status = 0;
      json = { error: String(error.message) };
    }
    const took = performance.now() - started;
    if (logging) steadyLog.push({ name, at: started, took });
    note(name, took, status >= 200 && status < 300, `${method} ${path.replace(/notebook-[\w-]+/, "notebook-…")} answered ${status}: ${JSON.stringify(json)?.slice(0, 160)}`);
    return { status, json };
  };
  const codeFor = async (email) => {
    for (let tries = 0; tries < 200; tries++) {
      const text = existsSync(join(data, "outbox.jsonl")) ? readFileSync(join(data, "outbox.jsonl"), "utf8") : "";
      const line = text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).reverse().find((mail) => mail.to === email);
      const code = /\b(\d{6})\b/.exec(line?.text ?? "")?.[1];
      if (code) return code;
      await sleep(25);
    }
    throw new Error(`no code was mailed to ${email}`);
  };

  const serverPid = child.pid;
  const serverBefore = cpuSeconds(serverPid);
  const clientBefore = process.cpuUsage();

  // --- sign up (a code is mailed and read back; the password is hashed with scrypt), then sign in again, all together ---
  let phase = performance.now();
  await pooled(people, o.ramp, async (p) => {
    await call(p, "sign up", "POST", "/api/register", { email: p.email, password: PASSWORD });
    await call(p, "confirm", "POST", "/api/verify", { email: p.email, code: await codeFor(p.email) });
  });
  const signUpSeconds = (performance.now() - phase) / 1000;
  phase = performance.now();
  await pooled(people, o.ramp, async (p) => {
    p.cookie = "";
    await call(p, "sign in", "POST", "/api/login", { email: p.email, password: PASSWORD });
  });
  const signInSeconds = (performance.now() - phase) / 1000;
  const signedIn = people.filter((p) => p.cookie);
  if (signedIn.length === 0) throw new Error(`nobody could sign in: ${[...failures].join()}`);

  // --- each person keeps a notebook on the server, then keeps it in step for a while ---
  const file = (n, round) => ({ path: `Page ${n}.txt`, base64: Buffer.from(`Content-Type: text/x-zim-wiki\n\n====== Page ${n} ======\nround ${round} `.padEnd(o.bytes, "x")).toString("base64") });
  await Promise.all(
    signedIn.map(async (p) => {
      p.names = Array.from({ length: o.files }, (_, n) => n);
      const made = await call(p, "send a notebook", "PUT", `/api/sync/notebooks/${p.id}`, { title: `Notebook ${p.i}`, baseRevision: 0, files: p.names.map((n) => file(n, 0)) });
      p.revision = made.json?.revision ?? 0;
    }),
  );
  const until = performance.now() + o.seconds * 1000;
  let rounds = 0;
  const steadyStart = performance.now();
  logging = true;
  // the storm: strangers, each from an address of its own, with an address of its own that has no account
  const storm = { from: 0, to: 0, answers: new Map() };
  const stormRun =
    o.storm > 0
      ? (async () => {
          await sleep((o.seconds * 1000) / 3);
          storm.from = performance.now();
          await Promise.all(
            Array.from({ length: o.storm }, async (_, n) => {
              const stranger = { address: `172.${(n >> 8) & 255}.${n & 255}.9`, cookie: "" };
              const answered = await call(stranger, "stranger signs in", "POST", "/api/login", { email: `stranger${n}-${randomBytes(3).toString("hex")}@example.org`, password: "not the password" });
              storm.answers.set(answered.status, (storm.answers.get(answered.status) ?? 0) + 1);
            }),
          );
          storm.to = performance.now();
        })()
      : Promise.resolve();
  await Promise.all(
    signedIn.map(async (p) => {
      for (let round = 1; performance.now() < until; round++) {
        await call(p, "who am I", "GET", "/api/me");
        await call(p, "list notebooks", "GET", "/api/sync/notebooks");
        const manifest = await call(p, "manifest", "GET", `/api/sync/notebooks/${p.id}/manifest`);
        if (manifest.status === 200) p.revision = manifest.json.revision ?? p.revision;
        // (three different pages: a change that names a file twice is refused)
        const changed = [...new Set(Array.from({ length: 12 }, () => Math.floor(Math.random() * o.files)))].slice(0, 3);
        const sent = await call(p, "send changed files", "PATCH", `/api/sync/notebooks/${p.id}`, { title: `Notebook ${p.i}`, baseRevision: p.revision, put: changed.map((n) => file(n, round)), remove: [] });
        if (sent.status === 200) p.revision = sent.json.revision ?? p.revision;
        await call(p, "read files", "POST", `/api/sync/notebooks/${p.id}/read`, { paths: changed.map((n) => `Page ${n}.txt`) });
        rounds++;
        if (o.think > 0) await sleep(o.think);
      }
    }),
  );
  await stormRun;
  logging = false;
  const steadySeconds = (performance.now() - steadyStart) / 1000;

  const serverCpu = cpuSeconds(serverPid) - serverBefore;
  const clientCpu = (() => {
    const used = process.cpuUsage(clientBefore);
    return (used.user + used.system) / 1e6;
  })();
  const memory = peakMemoryMiB(serverPid);
  const databaseMiB = (statSync(join(data, "zim.sqlite")).size + (existsSync(join(data, "zim.sqlite-wal")) ? statSync(join(data, "zim.sqlite-wal")).size : 0)) / 1048576;
  stop();
  await sleep(100);
  rmSync(data, { recursive: true, force: true });

  // what the storm did to the people who were keeping their notebooks in step: the same request before it, while it lasted, and after it
  let during = null;
  if (o.storm > 0) {
    const cheap = steadyLog.filter((r) => r.name === "who am I");
    const measure = (list) => {
      const sorted = list.map((r) => r.took).sort((a, b) => a - b);
      return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? 0 };
    };
    during = {
      before: measure(cheap.filter((r) => r.at + r.took < storm.from)),
      during: measure(cheap.filter((r) => r.at >= storm.from && r.at <= storm.to)),
      after: measure(cheap.filter((r) => r.at > storm.to)),
      stormSeconds: (storm.to - storm.from) / 1000,
      answers: Object.fromEntries(storm.answers),
    };
  }
  const rows = [...times].map(([name, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return { name, count: list.length, errors: failures.get(name) ?? 0, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1) };
  });
  const result = {
    users: o.users, signedIn: signedIn.length, files: o.files, bytes: o.bytes, seconds: o.seconds, think: o.think,
    signUpSeconds, signInSeconds, steadySeconds, rounds, roundsPerSecond: rounds / steadySeconds,
    serverCpuSeconds: serverCpu, clientCpuSeconds: clientCpu, serverPeakMiB: memory, databaseMiB, rows, storm: during,
  };
  if (o.json) return console.log(JSON.stringify(result, null, 2));
  console.log(`${o.users} people (${signedIn.length} signed in), each with ${o.files} files of about ${o.bytes} bytes; steady part ${o.seconds}s, ${o.think} ms between requests`);
  console.log(`sign up and confirm: ${signUpSeconds.toFixed(1)}s for all; sign in: ${signInSeconds.toFixed(1)}s for all (${(o.users / signInSeconds).toFixed(1)} per second)`);
  console.log(`keeping notebooks in step: ${rounds} rounds in ${steadySeconds.toFixed(1)}s (${result.roundsPerSecond.toFixed(1)} per second; a round is who-am-I, list, manifest, send 3 files, read 3 files)`);
  console.log(`the server used ${serverCpu.toFixed(1)}s of processor, peaked at ${memory.toFixed(0)} MiB, and its database is ${databaseMiB.toFixed(1)} MiB; this program used ${clientCpu.toFixed(1)}s of processor`);
  if (during) {
    console.log(`a storm of ${o.storm} sign-ins from strangers lasted ${during.stormSeconds.toFixed(1)}s (answers: ${JSON.stringify(during.answers)}); the same request "who am I" from the people already there:`);
    for (const when of ["before", "during", "after"]) console.log(`  ${when.padEnd(7)} ${String(during[when].count).padStart(5)} requests, p50 ${during[when].p50.toFixed(1)} ms, p95 ${during[when].p95.toFixed(1)} ms, worst ${during[when].max.toFixed(1)} ms`);
  }
  console.log("");
  console.log("request".padEnd(22) + "count".padStart(7) + "errors".padStart(8) + "p50 ms".padStart(9) + "p95 ms".padStart(9) + "p99 ms".padStart(9) + "max ms".padStart(9));
  for (const r of rows) console.log(r.name.padEnd(22) + String(r.count).padStart(7) + String(r.errors).padStart(8) + r.p50.toFixed(1).padStart(9) + r.p95.toFixed(1).padStart(9) + r.p99.toFixed(1).padStart(9) + r.max.toFixed(1).padStart(9));
  if ([...failures.values()].some((n) => n > 0)) {
    for (const [name, why] of firstFailures) console.log(`\nfirst failure of "${name}": ${why}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`load: ${error.message}`);
  process.exit(2);
});
