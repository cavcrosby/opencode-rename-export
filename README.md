# opencode-rename-export

This is a plugin for OpenCode that renames Markdown files created by OpenCode's
TUI session `/export` command using a configurable filename format.

The plugin listens for `file.watcher.updated` events and only handles filenames
matching OpenCode's current default export pattern, `session-XXXXXXXX.md`.
OpenCode's file watcher is currently an experimental feature and must be enabled
[via an environment variable](https://opencode.ai/docs/cli/#experimental).

## Installation

Add the plugin to your OpenCode configuration file
(`~/.config/opencode/opencode.json` or similar):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@cavcrosby/opencode-rename-export"]
}
```

To customize the format specifier, add the following instead (what's shown is
the default specifier):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@cavcrosby/opencode-rename-export",
      {
        "format": "{date}-{title}-{shortSessionID}.md"
      }
    ]
  ]
}
```

Supported tokens:

- `{title}`: session title
- `{date}`: export date in UTC (`YYYY-MM-DD`)
- `{time}`: export time in UTC (`HH-MM-SS`)
- `{sessionID}`: full session ID
- `{shortSessionID}`: first eight characters of the session ID
- `{project}`: project directory name

Token values are sanitized for use in cross-platform filenames. The renamed file
remains in the original export directory. Existing destination files are
overwritten.

When `VISUAL` or `EDITOR` is configured, the plugin waits for OpenCode's
post-editor write before renaming. If the editor exits unsuccessfully, OpenCode
does not perform that write and the file keeps its default name.

The export directory must be inside OpenCode's watched project directory, and
OpenCode's file watcher must be enabled.

## License

See LICENSE.
