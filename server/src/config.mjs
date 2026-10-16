// What the server is told: where it keeps its data, where it is reached, which sign-in services are set up, how it sends e-mail. From the
// environment, and from `config.json` and `oauth.json` in the data folder (the environment wins). Secrets are never in the code or the repository.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** The key that the server's codes are made with: made once, kept in the data folder, readable by its owner only. */
function secretFor(dataDir) {
  const file = join(dataDir, "secret.key");
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {object} [given] values that win over everything (tests)
 */
export function loadConfig(env = process.env, given = {}) {
  const dataDir = given.dataDir ?? env.ZIM_SERVER_DATA ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "zim-server");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = { ...readJson(join(dataDir, "config.json")) };
  const oauth = readJson(join(dataDir, "oauth.json"));
  const baseUrl = (given.baseUrl ?? env.ZIM_BASE_URL ?? file.baseUrl ?? "http://localhost:8080").replace(/\/+$/, "");

  const providers = {};
  for (const name of ["google", "github"]) {
    const clientId = env[`ZIM_${name.toUpperCase()}_CLIENT_ID`] ?? oauth[name]?.clientId;
    const clientSecret = env[`ZIM_${name.toUpperCase()}_CLIENT_SECRET`] ?? oauth[name]?.clientSecret;
    if (clientId && clientSecret) providers[name] = { clientId, clientSecret, ...(oauth[name]?.endpoints ? { endpoints: oauth[name].endpoints } : {}) };
  }

  // the apps that the connected services (Dropbox, Google Drive) are reached through: separate from the sign-in apps, with their own ids
  const connectorApps = {};
  for (const kind of ["dropbox", "gdrive"]) {
    const clientId = env[`ZIM_${kind.toUpperCase()}_CLIENT_ID`] ?? oauth[kind]?.clientId;
    const clientSecret = env[`ZIM_${kind.toUpperCase()}_CLIENT_SECRET`] ?? oauth[kind]?.clientSecret;
    if (clientId && clientSecret) connectorApps[kind] = { clientId, clientSecret };
  }

  const smtpHost = env.ZIM_SMTP_HOST ?? file.smtp?.host;
  return {
    dataDir,
    dbPath: given.dbPath ?? join(dataDir, "zim.sqlite"),
    baseUrl,
    secure: baseUrl.startsWith("https://"),
    secret: given.secret ?? secretFor(dataDir),
    /** Whether the address of the client can be taken from X-Forwarded-For (only behind a proxy that sets it). */
    trustProxy: given.trustProxy ?? (env.ZIM_TRUST_PROXY === "1" || file.trustProxy === true),
    sessionDays: given.sessionDays ?? 30,
    quotaBytes: given.quotaBytes ?? 1024 * 1024,
    providers: given.providers ?? providers,
    connectorApps: given.connectorApps ?? connectorApps,
    mail: given.mail ?? {
      driver: smtpHost ? "smtp" : "outbox",
      from: env.ZIM_MAIL_FROM ?? file.mail?.from ?? "Zim Notebook <no-reply@localhost>",
      outbox: join(dataDir, "outbox.jsonl"),
      smtp: smtpHost ? { host: smtpHost, port: Number(env.ZIM_SMTP_PORT ?? file.smtp?.port ?? 587), secure: (env.ZIM_SMTP_SECURE ?? file.smtp?.secure) === "1" || file.smtp?.secure === true, user: env.ZIM_SMTP_USER ?? file.smtp?.user, pass: env.ZIM_SMTP_PASS ?? file.smtp?.pass } : undefined,
    },
  };
}
