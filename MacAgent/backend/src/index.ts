#!/usr/bin/env node

//all tool descriptions were optimized by AI. Some of them were reworded to be more consice. All changes analyzed manually

// MCP server exposing the "agent" macOS user's screen (via Screen Sharing / VNC) as tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as screen from "./screen.js";
import os from "node:os";
import { type Proc, type Script, ancestors, bundleOf, formatAge, listProcesses, listScripts } from "./processes.js";
import { askPermission, quitApp, stopScript } from "./ask.js";

//creates new MCP Server
//name is the only necessary metadata cuz it ids server to mcp clients but including version seems professional.
const server = new McpServer({ name: "mac-vnc", version: "1.0.0" });

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

//for tool implementation
function wrap<A>(fn: (args: A) => Promise<Content[] | string>) {
  return async (args: A) => {
    try {
      const out = await fn(args);
      return { content: typeof out === "string" ? [{ type: "text" as const, text: out }] : out };
    } catch (e) {
      screen.disconnect();
      return { isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] };
    }
  };
}

//zod validation schema
const coord = z.number().int().min(0);

server.registerTool(
  "screenshot",
  {
    description:
      "Capture the agent Mac's screen. All other tools use coordinates in this screenshot's pixel space. " +
      "Take a screenshot before acting and after actions to check the result.",
  },
  wrap(async () => {
    const { png, width, height } = await screen.screenshot();
    return [
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      { type: "text", text: `Screenshot ${width}x${height}` },
    ];
  }),
);

server.registerTool(
  "click",
  {
    description: "Click at (x, y). Use count=2 for double-click.",
    inputSchema: {
      x: coord,
      y: coord,
      button: z.enum(["left", "right", "middle"]).default("left"),
      count: z.number().int().min(1).max(3).default(1),
    },
  },
  wrap(async ({ x, y, button, count }) => {
    await screen.click(x, y, button, count);
    return `Clicked ${button} x${count} at (${x}, ${y})`;
  }),
);

server.registerTool(
  "move",
  { description: "Move the mouse to (x, y) without clicking (e.g. to hover).", inputSchema: { x: coord, y: coord } },
  wrap(async ({ x, y }) => {
    await screen.move(x, y);
    return `Moved to (${x}, ${y})`;
  }),
);

server.registerTool(
  "drag",
  {
    description: "Press the left button at (from_x, from_y), drag to (to_x, to_y), and release.",
    inputSchema: { from_x: coord, from_y: coord, to_x: coord, to_y: coord },
  },
  wrap(async ({ from_x, from_y, to_x, to_y }) => {
    await screen.drag(from_x, from_y, to_x, to_y);
    return `Dragged (${from_x}, ${from_y}) → (${to_x}, ${to_y})`;
  }),
);

server.registerTool(
  "type_text",
  { description: "Type literal text into the focused field. \\n presses Return.", inputSchema: { text: z.string() } },
  wrap(async ({ text }) => {
    await screen.typeText(text);
    return `Typed ${text.length} characters`;
  }),
);

server.registerTool(
  "key",
  {
    description:
      'Press a key or shortcut, e.g. "return", "esc", "cmd+space", "cmd+shift+t", "cmd+tab", "down". ' +
      "Modifiers: cmd, shift, ctrl, alt/option.",
    inputSchema: { combo: z.string() },
  },
  wrap(async ({ combo }) => {
    await screen.pressKey(combo);
    return `Pressed ${combo}`;
  }),
);

server.registerTool(
  "scroll",
  {
    description: "Scroll at (x, y). amount is in wheel ticks.",
    inputSchema: {
      x: coord,
      y: coord,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(50).default(5),
    },
  },
  wrap(async ({ x, y, direction, amount }) => {
    await screen.scroll(x, y, direction, amount);
    return `Scrolled ${direction} ${amount} at (${x}, ${y})`;
  }),
);

server.registerTool(
  "wait",
  { description: "Wait for the UI to settle (e.g. an app launching).", inputSchema: { seconds: z.number().min(0).max(10) } },
  wrap(async ({ seconds }) => {
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return `Waited ${seconds}s`;
  }),
);

type Include = "apps" | "apps_and_scripts" | "all";

/** A text table of an account's processes, oldest first. appStatus fills CLOSABLE for apps. */
function processTable(user: string, olderThanDays: number | undefined, include: Include, appStatus: (p: Proc) => string) {
  const all = listProcesses(user);
  const kinds = { apps: ["app"], apps_and_scripts: ["app", "script"], all: ["app", "script", "background"] }[include];
  const minAge = (olderThanDays ?? 0) * 86400;
  const shown = all.filter((p) => kinds.includes(p.kind) && p.ageSeconds >= minAge);
  const appByPid = new Map(all.filter((p) => p.kind === "app").map((p) => [p.pid, p]));

  const rows = shown.map((p) => {
    const parent = appByPid.get(p.ppid);
    const closable =
      p.kind === "app" ? appStatus(p) : `no (${p.kind}${parent ? `, started by ${parent.name} PID ${parent.pid}` : ""})`;
    return [String(p.pid), p.name, p.kind, formatAge(p.ageSeconds), closable];
  });
  const header = ["PID", "NAME", "KIND", "RUNNING FOR", "CLOSABLE"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const table = [header, ...rows].map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()).join("\n");

  const closable = shown.filter((p) => p.kind === "app" && appStatus(p).startsWith("yes")).length;
  const scope = olderThanDays != null ? ` running at least ${olderThanDays} day(s)` : "";
  const summary = `${shown.length} process(es)${scope} in the "${user}" account; ${closable} closable.`;
  return shown.length ? `${table}\n\n${summary}` : summary;
}

server.registerTool(
  "list_processes",
  {
    description:
      "List the agent account's running processes with their PID and how long each has been running, oldest first. " +
      "Only processes marked closable (regular apps) may be closed; scripts and background processes must be left running. " +
      "To close an app: bring it to the front by name (click its Dock icon, or cmd+space, type the name, return), press cmd+q, " +
      "then take a screenshot and call list_processes again to confirm it is gone. " +
      'If a "save changes?" dialog appears, press Cancel (or esc), leave the app open, and report that it has unsaved work. ' +
      'Never choose "Don\'t Save". ' +
      "Quitting an app also ends background processes it started (shown as \"started by\"); mention those in your report.",
    inputSchema: {
      older_than_days: z.number().min(0).optional(),
      include: z.enum(["apps", "apps_and_scripts", "all"]).default("apps"),
    },
  },
  wrap(async ({ older_than_days, include }) => processTable(screen.USER, older_than_days, include, () => "yes")),
);


const ME = os.userInfo().username;
/** Never closable: the apps that run or show the agent. */
const PROTECTED_IDS = new Set(["local.mac-agent.bar", "com.apple.ScreenSharing"]);
let agentChain: number[] | undefined;
function isProtected(p: Proc): boolean {
  agentChain ??= ancestors(process.pid); // the processes this server runs inside, e.g. claude and its host app
  const id = bundleOf(p.path)?.bundleId;
  return agentChain.includes(p.pid) || (!!id && PROTECTED_IDS.has(id));
}

server.registerTool(
  "list_my_processes",
  {
    description:
      "List the USER's own account's running processes (not the agent's) with their PID and how long each has been running, oldest first. " +
      "Apps marked closable can only be closed with request_close_my_app, which asks the user first. " +
      "Use this only when the task is explicitly about the user's own apps; for the agent's account use list_processes.",
    inputSchema: {
      older_than_days: z.number().min(0).optional(),
      include: z.enum(["apps", "apps_and_scripts", "all"]).default("apps"),
    },
  },
  wrap(async ({ older_than_days, include }) =>
    processTable(ME, older_than_days, include, (p) => (isProtected(p) ? "no (protected: runs the agent)" : "yes (asks you first)")),
  ),
);

const declined = new Set<number>();
let asking = false;

server.registerTool(
  "request_close_my_app",
  {
    description:
      "Ask the user, with a dialog on THEIR screen, for permission to quit one of their own apps (a PID from list_my_processes), " +
      "and quit it normally if they click Allow. Use only when the task explicitly asks to close the user's own apps. " +
      "One app per call. If the user denies or doesn't answer, never ask about that app again; report it instead. " +
      "Finish by reporting which apps you asked about, which were closed, and which the user kept.",
    inputSchema: { pid: z.number().int().positive() },
  },
  wrap(async ({ pid }) => {
    if (declined.has(pid)) return `Not asked again: the user already declined closing PID ${pid}.`;
    const p = listProcesses(ME).find((x) => x.pid === pid);
    if (!p) return `PID ${pid} isn't running in the user's account, so nothing was asked.`;
    if (p.kind !== "app") return `${p.name} (PID ${pid}) is a ${p.kind} process, not an app; only apps can be closed.`;
    if (isProtected(p)) return `${p.name} (PID ${pid}) is protected because it runs or shows the agent; it can't be closed.`;
    const bundleId = bundleOf(p.path)?.bundleId;
    if (!bundleId) return `Couldn't identify ${p.name}'s app bundle, so nothing was asked.`;
    if (asking) return "Another permission request is already on the user's screen; wait for it, then try again.";

    let answer: Awaited<ReturnType<typeof askPermission>>;
    asking = true;
    try {
      answer = await askPermission(
        `quit ${p.name}`,
        `running ${formatAge(p.ageSeconds)}`,
        "If it has unsaved work, you'll get its normal save prompt.",
      );
    } finally {
      asking = false;
    }
    if (answer !== "allow") {
      declined.add(pid);
      return answer === "timeout"
        ? `No answer within 60 seconds, so ${p.name} (PID ${pid}) was left open. Treat this as a no.`
        : `The user denied it; ${p.name} (PID ${pid}) was left open.`;
    }

    const r = await quitApp(bundleId, pid);
    switch (r.status) {
      case "closed":
        return `The user allowed it; ${p.name} (PID ${pid}) has quit.`;
      case "still_open":
        return `The user allowed it, but ${p.name} (PID ${pid}) is still open, probably because the user kept it open at its save prompt.`;
      case "blocked":
        return `The user allowed it, but macOS blocked controlling ${p.name}. The user can allow it in System Settings → Privacy & Security → Automation.`;
      default:
        return `The user allowed it, but quitting ${p.name} (PID ${pid}) failed: ${r.detail ?? "unknown error"}`;
    }
  }),
);


/**
 * Processes that make up the agent itself: this server, everything above it, and everything under the
 * nearest `claude` above it (its other tool servers, shells, caffeinate…), or under our parent if none.
 */
function agentPids(): Set<number> {
  const chain = ancestors(process.pid);
  const pids = new Set([process.pid, ...chain]);
  const procs = listProcesses(ME);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const root = chain.find((pid) => /(^|\/)claude$/.test(byPid.get(pid)?.path ?? "")) ?? process.ppid;
  const children = new Map<number, number[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  for (const stack = [root]; stack.length; ) {
    const pid = stack.pop()!;
    pids.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return pids;
}

function stoppable(s: Script, mine: boolean): string {
  if (s.status === "protected") return "no (protected: part of the agent)";
  if (s.status === "service") return `no (service ${s.owner}: launchd would restart it)`;
  if (s.status === "part of app") return `no (part of ${s.owner}; close the app instead)`;
  return mine ? "yes (asks you first)" : "yes (agent may stop)";
}

server.registerTool(
  "list_scripts",
  {
    description:
      "List running scripts and programs someone started (python, java, node, shell scripts…), not apps or macOS services, " +
      'in the user\'s account (account "mine") or the agent\'s account (account "agent"), oldest first. ' +
      "Flags mark likely-unwanted ones: orphaned (whatever started it is gone), heavy (over 50% CPU or 1 GB memory), " +
      "duplicate (same command running more than once). Treat a script as unwanted only if the task says so or it is flagged, " +
      "and explain the flags in your report. Only stop scripts marked stoppable. " +
      "User's scripts: use request_stop_my_script (asks the user). " +
      "Agent's scripts: open Terminal in the agent account and run `kill <pid>` (the normal stop signal; never kill -9), " +
      'then call list_scripts with account "agent" to confirm it is gone. For "orphaned?" agent scripts, first check in that ' +
      "Terminal (e.g. `launchctl list | grep <pid>`) that it is not a service.",
    inputSchema: {
      account: z.enum(["mine", "agent"]).default("mine"),
      flagged_only: z.boolean().default(false),
    },
  },
  wrap(async ({ account, flagged_only }) => {
    const mine = account === "mine";
    const user = mine ? ME : screen.USER;
    const all = listScripts(user, mine ? agentPids() : new Set(), mine).sort((a, b) => b.ageSeconds - a.ageSeconds);
    const shown = flagged_only ? all.filter((s) => s.flags.length) : all;
    const rows = shown.map((s) => [
      String(s.pid),
      s.command,
      formatAge(s.ageSeconds),
      `${s.cpu}%`,
      `${s.memMB} MB`,
      s.flags.join(", ") || "-",
      stoppable(s, mine),
    ]);
    const header = ["PID", "COMMAND", "RUNNING FOR", "CPU", "MEM", "FLAGS", "STOPPABLE"];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const table = [header, ...rows].map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
    const canStop = shown.filter((s) => s.status === "yours").length;
    const flagged = shown.filter((s) => s.flags.length).length;
    const summary = `${shown.length} script(s) in the "${user}" account; ${canStop} stoppable, ${flagged} flagged.`;
    return shown.length ? `${table}\n\n${summary}` : summary;
  }),
);

server.registerTool(
  "request_stop_my_script",
  {
    description:
      "Ask the user, with a dialog on THEIR screen, for permission to stop one of their own scripts (a PID from list_scripts " +
      'with account "mine"), and send it the normal stop signal if they click Allow. It is never forced. ' +
      "One script per call. If the user denies or doesn't answer, never ask about that script again; report it instead.",
    inputSchema: { pid: z.number().int().positive() },
  },
  wrap(async ({ pid }) => {
    if (declined.has(pid)) return `Not asked again: the user already declined stopping PID ${pid}.`;
    const s = listScripts(ME, agentPids(), true).find((x) => x.pid === pid);
    if (!s) return `PID ${pid} isn't a running script in the user's account, so nothing was asked.`;
    if (s.status !== "yours") return `PID ${pid} can't be stopped: ${stoppable(s, true).replace(/^no \((.*)\)$/, "$1")}.`;
    if (asking) return "Another permission request is already on the user's screen; wait for it, then try again.";

    let answer: Awaited<ReturnType<typeof askPermission>>;
    asking = true;
    try {
      const flags = s.flags.length ? `, flagged: ${s.flags.join(", ")}` : "";
      answer = await askPermission(
        `stop the script "${s.command}"`,
        `PID ${pid}, running ${formatAge(s.ageSeconds)}${flags}`,
        "It will be asked to stop normally (not forced), so it can clean up.",
      );
    } finally {
      asking = false;
    }
    if (answer !== "allow") {
      declined.add(pid);
      return answer === "timeout"
        ? `No answer within 60 seconds, so PID ${pid} was left running. Treat this as a no.`
        : `The user denied it; "${s.command}" (PID ${pid}) was left running.`;
    }
    return (await stopScript(pid)) === "stopped"
      ? `The user allowed it; "${s.command}" (PID ${pid}) has stopped.`
      : `The user allowed it, but "${s.command}" (PID ${pid}) is still running: it ignored the stop signal (not forced).`;
  }),
);

//await waits for connection to be established between MCP and standard I/O
await server.connect(new StdioServerTransport());
