> [!NOTE]
> **Not published to the Zed extension marketplace yet.**
> I'm holding off on submitting to the marketplace while I clean up and polish the code a bit more. In the meantime, you can install it as a **Dev Extension**:
>
> 1. Clone this repository (`git clone https://github.com/outslept/zed-knip.git`)
> 2. In Zed, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **`zed: extensions`**
> 3. Click **Install Dev Extension** in the top-right corner and select the cloned `zed-knip` folder*
 
# Knip Editor Extension for Zed

Community [Zed](https://zed.dev) extension for [Knip](https://knip.dev): Find unused
files, dependencies, and exports in your JavaScript/TypeScript projects.

- Website: [knip.dev][1]
- GitHub repo: [webpro-nl/knip][2]
- Follow [@webpro.nl on Bluesky][3] for updates
- Blogpost: [Knip for Editors & Agents][4]
- [Sponsor Knip][5]

## What Is This?

[The usual suspects][6] like red squiggles for unused exports are there. What
really moves the needle for DX with Knip's module graph is **navigation**. A
completely unique way to view & fly through codebases for developers who care.
Connect the dots during development and refactors, while keeping things in
check.

1. **Hover over Export** for import & usage locations, entry paths, and export contention
2. **Hover over Dependencies** in `package.json` for direct links to import locations
3. **Inlay Hints (`↻ N imports`)** on exports with click-to-jump navigation

## Features

- Diagnostics for unused files, dependencies, and exports
- Hover on exports and `package.json` dependencies to see import locations
- Hover on circular imports and contended exports (`ambiguous`, `shadowed`, `converged`)
- Code actions to fix or ignore issues, including the install command for unlisted dependencies
- Inlay hints showing import counts (`↻ N imports`) for exports

## Screenshots & Contention

- [Lint Findings][6]
- [Imports & Exports][7]
- [Contention][8]
  - [Circular Dependencies][9]
  - [Ambiguous][10]
  - [Shadowed][11]
  - [Converged][12]
- [Zed Extension Settings][13]

### Lint Findings

![Lint Findings][14]

### Imports & Exports

![Imports & Exports][15]

### Contention

The extension shows circular dependencies and three kinds of export contention:
ambiguous, shadowed, and converged.

#### Circular Dependencies

If an import is part of a circular dependency, Knip will display:

![Circular Dependencies][16]

#### Ambiguous

Different bindings compete for the same name, with no winner. Knip lists the
competing bindings.

![Ambiguous][17]

#### Shadowed

An explicit export hides bindings from `export *`. Knip labels the site as
"shadowing" and lists the winning and hidden bindings.

![Shadowed][18]

#### Converged

The same binding arrives through multiple re-export paths. Knip shows where
those paths meet and the binding they share.

![Converged][19]

### Zed Extension Settings

#### Import Count Inlay Hints (`↻ N imports`)

To show Knip's `↻ N imports` hints without noisy TypeScript type/parameter hints, add this to your Zed `settings.json`:

```json
{
  "inlay_hints": {
    "enabled": true,
    "show_other_hints": true,
    "show_type_hints": false,
    "show_parameter_hints": false,
    "show_background": false
  }
}
```

#### Language Server Configuration

You can customize Knip under `lsp.knip` in your global or project `.zed/settings.json`:

```json
{
  "lsp": {
    "knip": {
      "initialization_options": {
        "cwd": "."
      },
      "settings": {
        "editor": {
          "severity": "default",
          "exports": {
            "codelens": { "enabled": true },
            "hover": {
              "enabled": true,
              "includeImportLocationSnippet": false,
              "maxSnippets": 10,
              "timeout": 300
            },
            "quickfix": { "enabled": true },
            "highlight": {
              "dimExports": false,
              "dimTypes": false,
              "dimEnumMembers": false,
              "dimDuplicates": false
            }
          },
          "dependencies": {
            "hover": { "enabled": true }
          }
        },
        "imports": { "enabled": true },
        "exports": {
          "enabled": true,
          "contention": { "enabled": true }
        }
      }
    }
  }
}
```

[1]: https://knip.dev
[2]: https://github.com/webpro-nl/knip
[3]: https://bsky.app/profile/webpro.nl
[4]: https://knip.dev/blog/for-editors-and-agents
[5]: https://knip.dev/sponsors
[6]: #lint-findings
[7]: #imports--exports
[8]: #contention
[9]: #circular-dependencies
[10]: #ambiguous
[11]: #shadowed
[12]: #converged
[13]: #zed-extension-settings
[14]: .github/assets/unused_exports.jpg
[15]: .github/assets/package_json.jpg
[16]: .github/assets/circular_dependencies.jpg
[17]: .github/assets/contention_ambiguous.jpg
[18]: .github/assets/contention_shadowed.jpg
[19]: .github/assets/contention_converged.jpg
