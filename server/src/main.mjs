// The process: the web app's files and the account API, in one server (the static server of web/scripts/serve.mjs with the API hooked in).
//
//   node src/main.mjs [--host 127.0.0.1] [--port 8080] [--tls [--name ADDRESS]...] [--download /address=file] [--dir ../web/dist] [--pid-file FILE]
//
// Where it is reached (`ZIM_BASE_URL`, e.g. https://localhost:8443) has to be the address that people type: the sign-in services send the browser back to it.
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer, downloadOption, selfSignedCertificate, urlsFor } from "../../web/scripts/serve.mjs";
import { Accounts } from "./accounts.mjs";
import { createApi } from "./api.mjs";
import { loadConfig } from "./config.mjs";
import { openDatabase } from "./db.mjs";
import { sweep } from "./limits.mjs";
import { createMailer } from "./mail.mjs";
import { OAuth } from "./oauth.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const options = { host: "127.0.0.1", port: 8080, dir: resolve(here, "../../web/dist"), tls: false, names: [], downloads: [], pidFile: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === "--host") options.host = value();
    else if (flag === "--port") options.port = Number(value());
    else if (flag === "--dir") options.dir = resolve(value());
    else if (flag === "--tls") options.tls = true;
    else if (flag === "--name") options.names.push(value());
    else if (flag === "--download") options.downloads.push(downloadOption(value()));
    else if (flag === "--pid-file") options.pidFile = resolve(value());
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("--port must be a number from 0 to 65535");
  return options;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    statSync(join(options.dir, "index.html"));
  } catch (error) {
    console.error(`server: ${error.code === "ENOENT" ? "web/dist is empty: run `npm run build` in web/ first" : error.message}`);
    process.exit(2);
  }
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
  const config = loadConfig(process.env);
  const db = openDatabase(config.dbPath);
  const mailer = createMailer(config.mail);
  const accounts = new Accounts({ db, mailer, config });
  const oauth = new OAuth({ db, accounts, config });
  const api = createApi({ accounts, oauth, config, log });

  const tls = options.tls ? selfSignedCertificate(undefined, options.names) : undefined;
  const server = createStaticServer({ dir: options.dir, tls: tls && { key: tls.key, cert: tls.cert }, authority: tls?.authority, downloads: options.downloads, api, log });
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `server: port ${options.port} is already in use on ${options.host}` : `server: ${error.message}`);
    process.exit(1);
  });
  const housekeeping = setInterval(() => {
    try {
      accounts.purge();
      sweep(db, Math.floor(Date.now() / 1000));
    } catch (error) {
      log(`housekeeping failed: ${error.message}`);
    }
  }, 3600_000);
  housekeeping.unref();

  server.listen(options.port, options.host, () => {
    const port = server.address().port;
    console.log(`Serving ${options.dir} with the account API${tls ? " over https" : ""}`);
    for (const url of urlsFor(options.host, port, tls ? "https" : "http")) console.log(`  ${url}`);
    console.log(`Address people use (ZIM_BASE_URL): ${config.baseUrl}${config.baseUrl.startsWith(tls ? "https:" : "http:") ? "" : "  <- does not match the scheme this server speaks"}`);
    console.log(`Sign in with: e-mail${Object.keys(config.providers).map((p) => `, ${p}`).join("")}. Mail goes to ${config.mail.driver === "smtp" ? "an SMTP server" : `a file (${config.mail.outbox}): no SMTP server is set up`}.`);
    console.log(`Data: ${config.dataDir}`);
    if (options.pidFile) writeFileSync(options.pidFile, `${process.pid}\n`);
  });
  const stop = () => {
    if (options.pidFile) {
      try {
        unlinkSync(options.pidFile);
      } catch {
        // already gone
      }
    }
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
