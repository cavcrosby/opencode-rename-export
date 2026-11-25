import type { PluginOptions } from "@opencode/plugin";
import { lstat, rename, rm } from "node:fs/promises";
import path from "node:path";

export const PLUGIN_ID = "cavcrosby.rename-export";
export const DEFAULT_FORMAT = "{date}-{title}-{shortSessionID}.{ext}";
const DEFAULT_EXPORT_PATTERN =
  /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(md|json)$/i;

const MARKDOWN_SESSION_ID_PATTERN = /^\*\*Session ID:\*\* *(\S+) *$/m;
const FORMAT_TOKEN_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const VALID_TOKENS = new Set([
  "title",
  "date",
  "time",
  "sessionID",
  "shortSessionID",
  "project",
  "ext",
]);
const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/;
const RETRYABLE_RENAME_ERRORS = new Set(["EBUSY", "ENOENT", "EPERM"]);

export type ExportExtension = "md" | "json";

export interface RenameExportOptions {
  format?: string;
}

export interface SessionInfo {
  id: string;
  title?: string;
}

export interface RenamerDependencies {
  directory: string;
  projectName: string;
  format: string;
  now(): Date;
  readFile(file: string): Promise<string>;
  getSession(sessionID: string): Promise<SessionInfo | undefined>;
  move(source: string, destination: string): Promise<void>;
  notify(
    message: string,
    variant: "success" | "error",
    sessionID?: string,
  ): Promise<void> | void;
  sleep?(milliseconds: number): Promise<void>;
}

function sanitizeToken(value: string | undefined, fallback: string) {
  const sanitized = (value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[ .-]+|[ .-]+$/g, "");

  return sanitized || fallback;
}

export function matchExportFilename(
  filename: string,
): ExportExtension | undefined {
  const match = DEFAULT_EXPORT_PATTERN.exec(filename);
  return match ? (match[1].toLowerCase() as ExportExtension) : undefined;
}

export function extractSessionID(content: string, extension: ExportExtension) {
  if (extension === "md") {
    return MARKDOWN_SESSION_ID_PATTERN.exec(content)?.[1];
  }

  try {
    const id = JSON.parse(content)?.info?.id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    // The export may still be in the middle of being written.
    return undefined;
  }
}

export function renderFilename(
  format: string,
  input: {
    session: SessionInfo;
    projectName: string;
    date: Date;
    extension: ExportExtension;
  },
) {
  const iso = input.date.toISOString();
  const values: Record<string, string> = {
    title: sanitizeToken(input.session.title, "untitled"),
    date: iso.slice(0, 10),
    time: iso.slice(11, 19).replaceAll(":", "-"),
    sessionID: sanitizeToken(input.session.id, "session"),
    shortSessionID: sanitizeToken(input.session.id.slice(0, 8), "session"),
    project: sanitizeToken(input.projectName, "project"),
    ext: input.extension,
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
  private readonly inFlight = new Set<string>();

  constructor(private readonly dependencies: RenamerDependencies) {}

  private async notify(
    message: string,
    variant: "success" | "error",
    sessionID?: string,
  ) {
    try {
      await this.dependencies.notify(message, variant, sessionID);
    } catch {
      // Renaming must not be reported as failed merely because a toast failed.
    }
  }

  private sleep(milliseconds: number) {
    return this.dependencies.sleep
      ? this.dependencies.sleep(milliseconds)
      : new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  private async readSessionID(source: string, extension: ExportExtension) {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await this.sleep(50 * attempt);
      }

      let content: string;
      try {
        content = await this.dependencies.readFile(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }

        throw error;
      }

      const sessionID = extractSessionID(content, extension);
      if (sessionID) {
        return sessionID;
      }
    }

    throw new Error("could not read the session ID from the export");
  }

  async handle(file: string) {
    const source = path.resolve(this.dependencies.directory, file);
    const extension = matchExportFilename(path.basename(source));
    if (!extension || this.inFlight.has(source)) {
      return;
    }

    this.inFlight.add(source);
    let sessionID: string | undefined;
    try {
      const id = await this.readSessionID(source, extension);
      if (id === null) {
        // Already renamed or removed; nothing left to do.
        return;
      }

      sessionID = id;
      const session = await this.dependencies.getSession(sessionID);
      if (!session) {
        throw new Error(`session '${sessionID}' was not found`);
      }

      const filename = renderFilename(this.dependencies.format, {
        session,
        projectName: this.dependencies.projectName,
        date: this.dependencies.now(),
        extension,
      });

      const destination = path.join(path.dirname(source), filename);
      if (destination === source) {
        return;
      }

      await this.dependencies.move(source, destination);
      await this.notify(
        `Session export renamed to ${filename}`,
        "success",
        sessionID,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.notify(
        `Failed to rename session export: ${message}`,
        "error",
        sessionID,
      );
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
