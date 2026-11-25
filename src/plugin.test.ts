import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_FORMAT,
  ExportRenamer,
  extractSessionID,
  matchExportFilename,
  moveWithOverwrite,
  readConfig,
  renderFilename,
  type SessionInfo,
} from "./plugin.ts";

const session: SessionInfo = {
  id: "ses_123456789abc",
  title: "Fix: export / filenames?",
};
const UUID = "0b9f6a52-3c1e-4d6a-9f0e-2a7b8c9d0e1f";
const MARKDOWN_EXPORT = `# Fix: export / filenames?

**Session ID:** ${session.id}
**Created:** 9/7/2026, 12:00:00 PM
**Updated:** 9/7/2026, 12:30:00 PM

---

## User
`;
const JSON_EXPORT = JSON.stringify({ info: session, messages: [] }, null, 2);

function enoent() {
  return Object.assign(new Error("not found"), { code: "ENOENT" });
}

function createHarness(
  input: {
    files?: Record<string, string | Array<string | Error>>;
    sessions?: SessionInfo[];
  } = {},
) {
  const files = input.files ?? { [`session-${UUID}.md`]: MARKDOWN_EXPORT };
  const moves: Array<{ source: string; destination: string }> = [];
  const notifications: Array<{
    message: string;
    variant: "success" | "error";
    sessionID?: string;
  }> = [];
  const reads = new Map<string, number>();
  const lookups: string[] = [];
  const renamer = new ExportRenamer({
    directory: "/workspace",
    projectName: "demo",
    format: DEFAULT_FORMAT,
    now: () => new Date("2026-09-07T12:34:56.000Z"),
    async readFile(file) {
      const name = path.basename(file);
      const count = reads.get(name) ?? 0;
      reads.set(name, count + 1);
      const entry = files[name];
      const value = Array.isArray(entry)
        ? entry[Math.min(count, entry.length - 1)]
        : entry;
      if (value === undefined) {
        throw enoent();
      }

      if (value instanceof Error) {
        throw value;
      }

      return value;
    },
    async getSession(sessionID) {
      lookups.push(sessionID);
      return (input.sessions ?? [session]).find(
        (candidate) => candidate.id === sessionID,
      );
    },
    async move(source, destination) {
      moves.push({ source, destination });
    },
    notify(message, variant, sessionID) {
      notifications.push({ message, variant, sessionID });
    },
    sleep: async () => {},
  });

  return { renamer, moves, notifications, reads, lookups };
}

test("readConfig defaults and validates format", () => {
  assert.equal(DEFAULT_FORMAT, "{date}-{title}-{shortSessionID}.{ext}");
  assert.deepEqual(readConfig(undefined), { format: DEFAULT_FORMAT });
  assert.deepEqual(readConfig({ format: "{project}-{title}.md" }), {
    format: "{project}-{title}.md",
  });

  assert.throws(() => readConfig({ format: "" }), /non-empty string/);
  assert.throws(
    () => readConfig({ format: "{unknown}.md" }),
    /unknown format token/,
  );

  assert.throws(
    () => readConfig({ format: "exports/{title}.{ext}" }),
    /filename, not a path/,
  );
});

test("renderFilename expands UTC tokens and sanitizes token values", () => {
  assert.equal(
    renderFilename(
      "{date}_{time}_{project}_{title}_{sessionID}_{shortSessionID}.{ext}",
      {
        session,
        projectName: "example project",
        date: new Date("2026-09-07T12:34:56.000Z"),
        extension: "json",
      },
    ),
    "2026-09-07_12-34-56_example-project_Fix-export-filenames_ses_123456789abc_ses_1234.json",
  );
});

test("renderFilename falls back to 'untitled' when the session has no title", () => {
  assert.equal(
    renderFilename(DEFAULT_FORMAT, {
      session: { id: session.id },
      projectName: "demo",
      date: new Date("2026-09-07T12:34:56.000Z"),
      extension: "md",
    }),
    "2026-09-07-untitled-ses_1234.md",
  );
});

test("matchExportFilename only accepts V2 default export names", () => {
  assert.equal(matchExportFilename(`session-${UUID}.md`), "md");
  assert.equal(matchExportFilename(`session-${UUID}.json`), "json");
  assert.equal(matchExportFilename("session-ses_1234.md"), undefined);
  assert.equal(matchExportFilename(`session-${UUID}.txt`), undefined);
  assert.equal(matchExportFilename(`notes-${UUID}.md`), undefined);
  assert.equal(matchExportFilename(`session-${UUID}.md.bak`), undefined);
});

test("extractSessionID reads Markdown headers and JSON info.id", () => {
  assert.equal(extractSessionID(MARKDOWN_EXPORT, "md"), session.id);
  assert.equal(extractSessionID(JSON_EXPORT, "json"), session.id);
  assert.equal(extractSessionID("# Partial", "md"), undefined);
  assert.equal(extractSessionID('{"info": {"id"', "json"), undefined);
  assert.equal(extractSessionID('{"info": {}}', "json"), undefined);
});

test("renames a Markdown export using the session from its header", async () => {
  const harness = createHarness();

  await harness.renamer.handle(`session-${UUID}.md`);

  assert.deepEqual(harness.lookups, [session.id]);
  assert.deepEqual(harness.moves, [
    {
      source: path.resolve(`/workspace/session-${UUID}.md`),
      destination: path.resolve(
        "/workspace/2026-09-07-Fix-export-filenames-ses_1234.md",
      ),
    },
  ]);
  assert.deepEqual(harness.notifications, [
    {
      message:
        "Session export renamed to 2026-09-07-Fix-export-filenames-ses_1234.md",
      variant: "success",
      sessionID: session.id,
    },
  ]);
});

test("renames a JSON export and keeps its extension", async () => {
  const harness = createHarness({
    files: { [`session-${UUID}.json`]: JSON_EXPORT },
  });

  await harness.renamer.handle(`session-${UUID}.json`);

  assert.equal(
    harness.moves[0]?.destination,
    path.resolve("/workspace/2026-09-07-Fix-export-filenames-ses_1234.json"),
  );
});

test("retries while the export is still being written", async () => {
  const harness = createHarness({
    files: {
      [`session-${UUID}.json`]: ["", '{"info": {"id"', JSON_EXPORT],
    },
  });

  await harness.renamer.handle(`session-${UUID}.json`);

  assert.equal(harness.reads.get(`session-${UUID}.json`), 3);
  assert.equal(harness.moves.length, 1);
});

test("reports an export whose session ID cannot be read", async () => {
  const harness = createHarness({
    files: { [`session-${UUID}.md`]: "# No header here" },
  });

  await harness.renamer.handle(`session-${UUID}.md`);

  assert.deepEqual(harness.moves, []);
  assert.equal(harness.notifications[0]?.variant, "error");
  assert.match(
    harness.notifications[0]?.message ?? "",
    /could not read the session ID/,
  );
});

test("ignores non-export files without reading them", async () => {
  const harness = createHarness();

  await harness.renamer.handle("session-ses_1234.md");
  await harness.renamer.handle(`session-${UUID}.txt`);
  await harness.renamer.handle("notes.md");

  assert.equal(harness.reads.size, 0);
  assert.deepEqual(harness.moves, []);
});

test("silently ignores events for exports that no longer exist", async () => {
  const harness = createHarness({ files: {} });

  await harness.renamer.handle(`session-${UUID}.md`);

  assert.deepEqual(harness.moves, []);
  assert.deepEqual(harness.notifications, []);
});

test("handles each export once when watcher events arrive together", async () => {
  const harness = createHarness();

  await Promise.all([
    harness.renamer.handle(`session-${UUID}.md`),
    harness.renamer.handle(`session-${UUID}.md`),
  ]);

  assert.equal(harness.moves.length, 1);
});

test("reports an unmatched session and leaves the file in place", async () => {
  const harness = createHarness({ sessions: [] });

  await harness.renamer.handle(`session-${UUID}.md`);

  assert.deepEqual(harness.moves, []);
  assert.equal(harness.notifications[0]?.variant, "error");
  assert.match(harness.notifications[0]?.message ?? "", /was not found/);
});

test("moveWithOverwrite replaces an existing destination", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencode-rename-export-"),
  );

  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, `session-${UUID}.md`);
  const destination = path.join(directory, "renamed.md");
  await writeFile(source, "new transcript");
  await writeFile(destination, "old transcript");

  await moveWithOverwrite(source, destination);

  assert.equal(await readFile(destination, "utf8"), "new transcript");
  await assert.rejects(readFile(source, "utf8"), { code: "ENOENT" });
});
