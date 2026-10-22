// What the server is told (src/config.mjs): where its data is, and how many passwords it hashes at once.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { dataDirOf, loadConfig } from "../src/config.mjs";

const folders = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));
const scratch = () => {
  const folder = mkdtempSync(join(tmpdir(), "zim-config-test-"));
  folders.push(folder);
  return folder;
};

describe("where the data is", () => {
  it("is what the server reads: ZIM_SERVER_DATA, else the folder `zim-server` of the state folder", () => {
    assert.equal(dataDirOf({ ZIM_SERVER_DATA: "/srv/zim" }), "/srv/zim");
    assert.equal(dataDirOf({ ZIM_SERVER_DATA: "/srv/zim", XDG_STATE_HOME: "/state" }), "/srv/zim");
    assert.equal(dataDirOf({ XDG_STATE_HOME: "/state" }), "/state/zim-server");
    assert.equal(dataDirOf({}), join(homedir(), ".local/state", "zim-server"));
  });
});

describe("the data folder", () => {
  it("is for its owner only: made so, or made so when it was there before with a mode that others can read", () => {
    const made = join(scratch(), "data");
    loadConfig({ ZIM_SERVER_DATA: made });
    assert.equal(statSync(made).mode & 0o777, 0o700);
    const before = scratch();
    chmodSync(before, 0o775);
    loadConfig({ ZIM_SERVER_DATA: before });
    assert.equal(statSync(before).mode & 0o777, 0o700);
  });
});

describe("the settings for hashing passwords", () => {
  it("are nothing when nobody said anything, so that the code's own defaults stand", () => {
    const config = loadConfig({ ZIM_SERVER_DATA: scratch() });
    assert.equal(config.hashSlots, undefined);
    assert.equal(config.hashQueue, undefined);
    const empty = loadConfig({ ZIM_SERVER_DATA: scratch(), ZIM_HASH_SLOTS: "", ZIM_HASH_QUEUE: "" });
    assert.equal(empty.hashSlots, undefined, "an empty one is none");
    assert.equal(empty.hashQueue, undefined);
  });

  it("come from the environment or from config.json, the environment first", () => {
    const dataDir = scratch();
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ hashSlots: 4, hashQueue: 9 }));
    const fromFile = loadConfig({ ZIM_SERVER_DATA: dataDir });
    assert.deepEqual([fromFile.hashSlots, fromFile.hashQueue], [4, 9]);
    const fromEnvironment = loadConfig({ ZIM_SERVER_DATA: dataDir, ZIM_HASH_SLOTS: "2", ZIM_HASH_QUEUE: "30" });
    assert.deepEqual([fromEnvironment.hashSlots, fromEnvironment.hashQueue], [2, 30]);
    assert.deepEqual(loadConfig({ ZIM_SERVER_DATA: scratch(), ZIM_HASH_SLOTS: "1" }).hashSlots, 1);
    assert.equal(loadConfig({ ZIM_SERVER_DATA: scratch() }, { hashSlots: 7 }).hashSlots, 7, "and what a test gives wins over both");
  });

  it("are refused when they are not a whole number of at least one, and the message says which setting and what it was", () => {
    for (const bad of ["0", "-1", "1.5", "lots", "NaN", "Infinity"]) {
      assert.throws(() => loadConfig({ ZIM_SERVER_DATA: scratch(), ZIM_HASH_SLOTS: bad }), { message: `ZIM_HASH_SLOTS must be a whole number of at least 1 (it is ${JSON.stringify(bad)})` }, bad);
      assert.throws(() => loadConfig({ ZIM_SERVER_DATA: scratch(), ZIM_HASH_QUEUE: bad }), /ZIM_HASH_QUEUE must be a whole number of at least 1/, bad);
    }
    // in config.json the same, and a value that is not a number or a string is not taken for one (true is not 1)
    for (const bad of [0, 2.5, true, null, [3], {}]) {
      const dataDir = scratch();
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ hashSlots: bad }));
      assert.throws(() => loadConfig({ ZIM_SERVER_DATA: dataDir }), /ZIM_HASH_SLOTS must be a whole number of at least 1/, JSON.stringify(bad));
    }
  });
});
