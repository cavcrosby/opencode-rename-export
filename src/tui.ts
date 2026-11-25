import type { Plugin } from "@opencode/plugin/tui";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ExportRenamer,
  moveWithOverwrite,
  PLUGIN_ID,
  readConfig,
} from "./plugin.ts";

const RenameExportTuiPlugin: Plugin.Definition = {
  id: PLUGIN_ID,
  setup(ctx) {
    const config = readConfig(ctx.options);
    const directory = process.cwd();
    const renamer = new ExportRenamer({
      directory,
      projectName: path.basename(ctx.location?.directory ?? directory),
      format: config.format,
      now: () => new Date(),
      readFile: (file) => readFile(file, "utf8"),
      async getSession(sessionID) {
        return (
          ctx.data.session.get(sessionID) ??
          (await ctx.client.session.get({ sessionID }))
        );
      },
      move: moveWithOverwrite,
      notify(message, variant, sessionID) {
        ctx.ui.toast.show({ message, variant, sessionID });
      },
    });

    const watcher = watch(
      directory,
      { encoding: "utf8", persistent: false },
      (_, filename) => {
        if (filename) {
          void renamer.handle(filename);
        }
      },
    );
    watcher.on("error", (error) => {
      ctx.ui.toast.show({
        message: `Session export renaming stopped: ${error.message}`,
        variant: "error",
      });
    });

    return () => {
      watcher.close();
    };
  },
};

export default RenameExportTuiPlugin;
