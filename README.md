# opencode-rename-export

This is a plugin for OpenCode that renames Markdown and JSON files created by
OpenCode's TUI session `/export` command using a configurable filename format.

Version 2.0.0 and later of this plugin only support OpenCode V2. For OpenCode
V1, use version `1.x` of this plugin.

The plugin watches the TUI's working directory, which is where OpenCode saves
exports, and only handles filenames matching OpenCode's current default export
pattern, `session-<uuid>.md` or `session-<uuid>.json`.

## Installation

Add the plugin to your OpenCode configuration file
(`~/.config/opencode/opencode.json` or similar):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@cavcrosby/opencode-rename-export"]
}
```

To customize the format specifier, add the following instead (what's shown is
the default specifier):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@cavcrosby/opencode-rename-export",
      "options": {
        "format": "{date}-{title}-{shortSessionID}.{ext}"
      }
    }
  ]
}
```

Supported tokens:

- `{title}`: session title (`untitled` if the session has none)
- `{date}`: export date in UTC (`YYYY-MM-DD`)
- `{time}`: export time in UTC (`HH-MM-SS`)
- `{sessionID}`: full session ID
- `{shortSessionID}`: first eight characters of the session ID
- `{project}`: project directory name
- `{ext}`: the export's extension (`md` or `json`)

If the format hard-codes an extension instead of using `{ext}`, it is used for
both Markdown and JSON exports.

Token values are sanitized for use in cross-platform filenames. The renamed file
remains in the original export directory. Existing destination files are
overwritten. A toast (a brief pop-up notification in the TUI) reports each
rename or failure.

Exports saved to the system's temporary directory are not renamed.

## License

See LICENSE.
