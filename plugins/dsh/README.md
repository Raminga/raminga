# @raminga/dsh

Operate a local [Raminga](https://github.com/Raminga/raminga) node from DSH.
The plugin registers the `raminga_*` tools, injects the Raminga operating
guide, and starts the local daemon on first use.

## Install

```sh
# Prerelease
dsh plugin --profile <name> add @raminga/dsh@next

# Stable release
dsh plugin --profile <name> add @raminga/dsh
```

The matching `@raminga/bin-<os>-<cpu>` package is installed automatically for
macOS, Linux and Windows on arm64 or x64. The shell never bundles a binary.

## Binary selection

The plugin uses, in order:

1. the `ramingaBin` plugin config option;
2. `$RAMINGA_BIN`;
3. the installed `@raminga/bin-<os>-<cpu>` package;
4. `raminga` on `PATH`.

If no bundled package is available, the plugin falls back to `PATH` and reports
a diagnostic when it cannot start the daemon. The node data directory is
`$RAMINGA_DATA_DIR`, else `~/.raminga`; it is shared by every host.

## Links

- [Install guide](https://github.com/Raminga/raminga/blob/main/docs/install.md)
- [Security boundaries](https://github.com/Raminga/raminga/blob/main/docs/security.md)
- [Issues](https://github.com/Raminga/raminga/issues)
