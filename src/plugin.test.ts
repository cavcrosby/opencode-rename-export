import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_FORMAT,
  ExportRenamer,
  moveWithOverwrite,
  readConfig,
  renderFilename,
  type SessionInfo,
} from "./plugin.ts";

const session: SessionInfo = {
  id: "ses_123456789",
  title: "Fix: export / filenames?",
};

function createHarness(
  input: { editorConfigured?: boolean; sessions?: SessionInfo[] } = {},
) {
  const moves: Array<{ source: string; destination: string }> = [];
  const notifications: Array<{
    message: string;
    variant: "success" | "error";
  }> = [];
  let listCalls = 0;
  const renamer = new ExportRenamer({
    directory: "/workspace",
    projectName: "demo",
    format: "{date}-{title}-{shortSessionID}.md",
    editorConfigured: input.editorConfigured ?? false,
    now: () => new Date("2026-09-07T12:34:56.000Z"),
    async listSessions() {
      listCalls++;
      return input.sessions ?? [session];
    },
    async move(source, destination) {
      moves.push({ source, destination });
    },
    async notify(message, variant) {
      notifications.push({ message, variant });
    },
  });

  return {
    renamer,
    moves,
    notifications,
    get listCalls() {
      return listCalls;
    },
  };
}

test("readConfig defaults and validates format", () => {
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
    () => readConfig({ format: "exports\/{title}.md" }),
    /filename, not a path/,
  );
});

test("renderFilename expands UTC tokens and sanitizes token values", () => {
  assert.equal(
    renderFilename(
      "{date}_{time}_{project}_{title}_{sessionID}_{shortSessionID}.md",
      {
        session,
        projectName: "example project",
        date: new Date("2026-09-07T12:34:56.000Z"),
      },
    ),
    "2026-09-07_12-34-56_example-project_Fix-export-filenames_ses_123456789_ses_1234.md",
  );
});

test("renames an exact default export after an add event when no editor is configured", async () => {
  const harness = createHarness();

  await harness.renamer.handle({ file: "session-ses_1234.md", event: "add" });

  assert.deepEqual(harness.moves, [
    {
      source: path.resolve("/workspace/session-ses_1234.md"),
      destination: path.resolve(
        "/workspace/2026-09-07-Fix-export-filenames-ses_1234.md",
      ),
    },
  ]);

  assert.equal(harness.notifications[0]?.variant, "success");
});

test("ignores filenames that only share the session prefix", async () => {
  const harness = createHarness();

  await harness.renamer.handle({
    file: "session-not-a-default-export.md",
    event: "add",
  });

  await harness.renamer.handle({ file: "session-ses_1234.txt", event: "add" });
  await harness.renamer.handle({ file: "notes.md", event: "add" });

  assert.equal(harness.listCalls, 0);
  assert.deepEqual(harness.moves, []);
});

test("waits for the post-editor change event before renaming", async () => {
  const harness = createHarness({ editorConfigured: true });
  const event = { file: "session-ses_1234.md", event: "add" as const };

  await harness.renamer.handle(event);
  assert.deepEqual(harness.moves, []);

  await harness.renamer.handle({ ...event, event: "change" });
  assert.equal(harness.moves.length, 1);
});

test("leaves the default filename when no post-editor change follows", async () => {
  const harness = createHarness({ editorConfigured: true });

  await harness.renamer.handle({ file: "session-ses_1234.md", event: "add" });

  assert.equal(harness.listCalls, 0);
  assert.deepEqual(harness.moves, []);
  assert.deepEqual(harness.notifications, []);
});

test("reports an unmatched session and leaves the file in place", async () => {
  const harness = createHarness({ sessions: [] });

  await harness.renamer.handle({ file: "session-ses_1234.md", event: "add" });

  assert.deepEqual(harness.moves, []);
  assert.equal(harness.notifications[0]?.variant, "error");
  assert.match(harness.notifications[0]?.message ?? "", /was not found/);
});

test("moveWithOverwrite replaces an existing destination", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencode-rename-export-"),
  );

  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "session-ses_1234.md");
  const destination = path.join(directory, "renamed.md");
  await writeFile(source, "new transcript");
  await writeFile(destination, "old transcript");

  await moveWithOverwrite(source, destination);

  assert.equal(await readFile(destination, "utf8"), "new transcript");
  await assert.rejects(readFile(source, "utf8"), { code: "ENOENT" });
});
