#SIMA - Session Isolated Modular Agent

##Inspiration

### "The first- level digital divide shifts from inequalities in physical access to inequalities in material access" - Van Deursen & Van Djik

This made me think of how every technological breakthrough is followed by a new form of digital divide associated with it. From computers to World Wide Web to Smartphones. While AI Chatbots have become prevelant among a diverse demographic, AI agents despite their diverse functionalities and capabilities still are consolidated among a cream of tech enthusiasts. The major reason for this is the complexity involved with creating such Agents.

##Solution

SIMA is a modular computer use agent that is meant to be accessible, adaptable, interactive and FUN! 

1. SIMA uses a modular architecture that focuses on local machine integration without necessitating API integrations and VM deployment. SIMA registers as a Second Profile on the user's device and stores all secrets through Apple's Keychain. To increase accessibility, A VNC is established to monitor and cowork on the same profile. 

2. SIMA skips overhead API costs and related complexity by using an MCP architecture on top of the user's coding agent,eg: Claude Code, Codex. Not only are such agents becoming more prevelant, but their tokens are often underutilized by most. SIMA builds on these trends and runs the agent headlessly to maximize abstraction

3.SIMA supports distant chat capability with agent using Photon's Spectrum framework, allowing real time task allocation from afar.

## Project layout

- `MacAgent/backend/` — a TypeScript MCP server (`mac-vnc`) that exposes the agent profile's screen as tools: screenshot, click, type, scroll, process listing, and permission dialogs.
- `MacAgent/menubar/` — a Swift menu bar app (`MacAgentBar`) that takes a task, runs the coding agent headlessly with the MCP server, and shows the result. It can also take tasks by iMessage.
- `MacAgent/scripts/` — setup and build scripts.

##What We Learned

-Apple Authentication using Diffie-Hellman key exchange
-Setting up VNC client using RFB protocol
-Complexity of binary handling 


## Tools and frameworks

### Languages and toolchains

- TypeScript 7 on Node.js, compiled with `tsc` to ES modules — the backend
- Swift (tools version 5.9) with Swift Package Manager — the menu bar app
- zsh — the scripts

### Apple frameworks

- SwiftUI and AppKit — the menu bar popup, drawers and dialogs
- Network — the local viewer proxy on port 5901
- Security — the Photon secret in the Keychain
- Foundation, `os` (logging), Darwin


### Backend packages

- `@modelcontextprotocol/sdk` — the MCP server and its stdio transport
- `zod` — input schemas for the MCP tools
- `pngjs` — encoding screenshots as PNG
- `@spectrum-ts/core`, `@spectrum-ts/imessage` — Photon Spectrum, for receiving and sending iMessages
- Dev: `typescript`, `@types/node`, `@types/pngjs`
- Node built-ins: `net` (the VNC/RFB client in `rfb.ts`), `crypto` (Apple Remote Desktop sign-in in `ARD_Auth.ts`), `child_process`, `fs`, `os`, `events`, `readline`, `url`, and the `node --test` runner


### External programs

- `claude` — Claude Code CLI; the app runs `claude -p` for each task
- `node` — runs the MCP server, the live-screen viewer and the iMessage bridge
- `osascript` — Allow/Deny dialogs and quitting apps
- `ps`, `launchctl`, `plutil` — listing processes and reading app metadata
- `security` — reading the agent's password from the Keychain
- `sysadminctl`, `sudo`, `codesign`, `npm`, `swift build` — setup and build scripts only

### macOS services

- Screen Sharing (VNC, port 5900) with a separate `agent` user account
- Keychain, under the services `mac-agent-vnc` and `mac-agent-spectrum`
- The shared folder `/Users/Shared/agent-shared`, for passing documents to the agent

### MCP tools exposed to the agent

`screenshot`, `click`, `move`, `drag`, `type_text`, `key`, `scroll`, `wait`, `list_processes`, `list_scripts`, `list_my_processes`, `request_close_my_app`, `request_stop_my_script`



## Requirements

- macOS 14 or later, with Screen Sharing turned on (System Settings → General → Sharing)
- Node.js at `/opt/homebrew/bin/node` (Homebrew)
- Swift toolchain (Xcode or the Command Line Tools)
- Claude Code CLI at `~/.local/bin/claude`
- For tasks by text message: a Photon Spectrum project (app.photon.codes)



##Scalability and Accessibility

### Build and run

All commands run from `MacAgent/`.

### One-time setup

```sh
./scripts/setup-agent-user.sh
```

Creates the standard `agent` user (asks for your admin password) and saves its password to your Keychain under the service `mac-agent-vnc`. Then follow the steps it prints: allow the agent in Screen Sharing and sign in to its session once at `vnc://agent@localhost`.

### Build and install everything

```sh
./scripts/build-app.sh
open ~/Applications/MacAgentBar.app
```

Builds the MCP server and the menu bar app, wraps the app in a signed bundle, and installs it to `~/Applications/MacAgentBar.app`, replacing any existing copy.

Run the installed bundle rather than the raw binary in `menubar/.build/`: saved settings and the iMessage setup are stored under the bundle's ID (`local.mac-agent.bar`).

### Backend only

Run from `MacAgent/backend/`.

| Command | What it does |
|---|---|
| `npm install` | Installs dependencies |
| `npm run build` | Compiles `src/` to `dist/` with `tsc` |
| `npm test` | Compiles, then runs the tests with Node's test runner |
| `npm run spike` | Connects as the agent and saves `spike.png`; it should show the agent's desktop, not yours |
| `npm run fake-vnc` | Compiles, then starts the fake VNC server used by the tests |

### Menu bar app only

Run from `MacAgent/menubar/`.

| Command | What it does |
|---|---|
| `swift build` | Debug build |
| `swift build -c release` | Release build (what `build-app.sh` uses) |

### Configuration

The backend reads these environment variables; all are optional. 

| Variable | Default | Purpose |
|---|---|---|
| `MAC_AGENT_HOST` | `127.0.0.1` | VNC host |
| `MAC_AGENT_PORT` | `5900` | VNC port |
| `MAC_AGENT_USER` | `agent` | Account to sign in as |
| `MAC_AGENT_PASSWORD` | read from the Keychain | The agent's password |
| `MAC_AGENT_MAX_WIDTH` | `1280` | Maximum screenshot width in pixels |
| `MAC_AGENT_CMD_KEYSYM` | `0xffeb` | Key code sent for the cmd key |

The iMessage bridge (`dist/imessages.js`) also needs `MAC_AGENT_IMESSAGE_HANDLE`, `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET`; the menu bar app sets these from its setup dialog.

##AI Use Disclosure

The complexity and scale of the project necessitated the educational use of AI.