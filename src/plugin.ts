import type { Plugin, PluginOptions } from "@opencode-ai/plugin";
import { lstat, rename, rm } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_FORMAT = "{date}-{title}-{shortSessionID}.md";

const DEFAULT_EXPORT_PATTERN = /^session-([A-Za-z0-9_-]{8})\.md$/;
const FORMAT_TOKEN_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const VALID_TOKENS = new Set([
  "title",
  "date",
  "time",
  "sessionID",
  "shortSessionID",
  "project",
]);
const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/;
const RETRYABLE_RENAME_ERRORS = new Set(["EBUSY", "ENOENT", "EPERM"]);

export interface RenameExportOptions extends PluginOptions {
  format?: string;
}

export interface SessionInfo {
  id: string;
  title: string;
}

export interface FileWatcherEvent {
  file: string;
  event: "add" | "change" | "unlink";
}

interface RenamerDependencies {
  directory: string;
  projectName: string;
  format: string;
  editorConfigured: boolean;
  now(): Date;
  listSessions(): Promise<SessionInfo[]>;
  move(source: string, destination: string): Promise<void>;
  notify(message: string, variant: "success" | "error"): Promise<void>;
}

function sanitizeToken(value: string, fallback: string) {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[ .-]+|[ .-]+$/g, "");

  return sanitized || fallback;
}

export function renderFilename(
  format: string,
  input: { session: SessionInfo; projectName: string; date: Date },
) {
  const iso = input.date.toISOString();
  const values: Record<string, string> = {
    title: sanitizeToken(input.session.title, "untitled"),
    date: iso.slice(0, 10),
    time: iso.slice(11, 19).replaceAll(":", "-"),
    sessionID: sanitizeToken(input.session.id, "session"),
    shortSessionID: sanitizeToken(input.session.id.slice(0, 8), "session"),
    project: sanitizeToken(input.projectName, "project"),
  };

  const filename = format.replace(
    FORMAT_TOKEN_PATTERN,
    (_, token: string) => values[token] ?? "",
  );
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    path.basename(filename) !== filename
  ) {
    throw new Error("configured format did not produce a valid filename");
  }

  if (INVALID_FILENAME_CHARACTERS.test(filename)) {
    throw new Error(
      "configured format produced a filename containing invalid characters",
    );
  }

  if (Buffer.byteLength(filename) > 255) {
    throw new Error(
      "configured format produced a filename longer than 255 bytes",
    );
  }

  const stem = path.parse(filename).name.toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new Error("configured format produced a reserved filename");
  }

  return filename;
}

export class ExportRenamer {
  private readonly pendingEditorWrites = new Set<string>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly dependencies: RenamerDependencies) {}

  private async notify(message: string, variant: "success" | "error") {
    try {
      await this.dependencies.notify(message, variant);
    } catch {
      // Renaming must not be reported as failed merely because no TUI is connected.
    }
  }

  private async rename(source: string, shortSessionID: string) {
    const matches = (await this.dependencies.listSessions()).filter(
      (session) => session.id.slice(0, 8) === shortSessionID,
    );

    if (matches.length === 0) {
      throw new Error(`session '${shortSessionID}' was not found`);
    }

    if (matches.length > 1) {
      throw new Error(`session prefix '${shortSessionID}' is ambiguous`);
    }

    const filename = renderFilename(this.dependencies.format, {
      session: matches[0],
      projectName: this.dependencies.projectName,
      date: this.dependencies.now(),
    });

    const destination = path.join(path.dirname(source), filename);
    if (destination === source) {
      return;
    }

    await this.dependencies.move(source, destination);
    return destination;
  }

  async handle(event: FileWatcherEvent) {
    if (event.event === "unlink") {
      return;
    }

    const source = path.resolve(this.dependencies.directory, event.file);
    const match = DEFAULT_EXPORT_PATTERN.exec(path.basename(source));
    if (!match) {
      return;
    }

    if (this.dependencies.editorConfigured && event.event === "add") {
      this.pendingEditorWrites.add(source);
      return;
    }

    if (
      this.dependencies.editorConfigured &&
      !this.pendingEditorWrites.delete(source)
    ) {
      return;
    }

    if (this.inFlight.has(source)) {
      return;
    }

    this.inFlight.add(source);
    try {
      const destination = await this.rename(source, match[1]);
      if (destination) {
        await this.notify(
          `Session export renamed to ${path.basename(destination)}`,
          "success",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.notify(`Failed to rename session export: ${message}`, "error");
    } finally {
      this.inFlight.delete(source);
    }
  }
}

export async function moveWithOverwrite(source: string, destination: string) {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile()) {
    throw new Error("export path is not a regular file");
  }

  const destinationInfo = await lstat(destination).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }

      throw error;
    },
  );

  if (destinationInfo?.isDirectory()) {
    throw new Error("destination is a directory");
  }

  if (destinationInfo) {
    await rm(destination, { force: true });
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !code || !RETRYABLE_RENAME_ERRORS.has(code)) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

export function readConfig(
  options: PluginOptions | undefined,
): Required<RenameExportOptions> {
  const format = options?.format ?? DEFAULT_FORMAT;
  if (typeof format !== "string" || format.trim() === "") {
    throw new Error(
      "opencode-rename-export: 'format' must be a non-empty string",
    );
  }

  const tokens = [...format.matchAll(FORMAT_TOKEN_PATTERN)].map(
    (match) => match[1],
  );
  const unknown = tokens.find((token) => !VALID_TOKENS.has(token));
  if (unknown) {
    throw new Error(
      `opencode-rename-export: unknown format token '{${unknown}}'`,
    );
  }

  const literals = format.replace(FORMAT_TOKEN_PATTERN, "");
  if (INVALID_FILENAME_CHARACTERS.test(literals) || /[{}]/.test(literals)) {
    throw new Error(
      "opencode-rename-export: 'format' must produce a filename, not a path",
    );
  }

  return { format };
}

export const RenameExportPlugin: Plugin = async (
  { client, directory, project },
  options,
) => {
  const config = readConfig(options);
  const renamer = new ExportRenamer({
    directory,
    projectName: path.basename(project.worktree) || "project",
    format: config.format,
    editorConfigured: Boolean(process.env.VISUAL || process.env.EDITOR),
    now: () => new Date(),
    async listSessions() {
      const result = await client.session.list({
        query: { directory },
        throwOnError: true,
      });
      return result.data;
    },
    move: moveWithOverwrite,
    async notify(message, variant) {
      await client.tui.showToast({
        body: { message, variant },
        query: { directory },
      });
    },
  });

  return {
    event: async ({ event }) => {
      if (event.type !== "file.watcher.updated") {
        return;
      }

      await renamer.handle(event.properties);
    },
  };
};
