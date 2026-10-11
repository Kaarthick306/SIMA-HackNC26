// Running processes for a macOS account, with PID and how long each has been running.
// Read-only: closing happens elsewhere (cmd+q on the agent's screen, or ask.ts for your own apps).
import { execFileSync } from "node:child_process";

export type Kind = "app" | "script" | "background";

export interface Proc {
  pid: number;
  ppid: number;
  name: string;
  path: string;
  kind: Kind;
  ageSeconds: number;
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
export function parseElapsed(etime: string): number {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = clock.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return ((Number(days) * 24 + h) * 60 + m) * 60 + s;
}

/** Seconds as "8d 3h 12m", "3h 12m" or "12m". */
export function formatAge(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const plistCache = new Map<string, Record<string, string>>();

/** A key from an app bundle's Info.plist, read with plutil (no shell), cached per bundle. */
function plistValue(bundlePath: string, key: string): string | undefined {
  let entry = plistCache.get(bundlePath);
  if (!entry) plistCache.set(bundlePath, (entry = {}));
  if (!(key in entry)) {
    try {
      entry[key] = execFileSync("plutil", ["-extract", key, "raw", "-o", "-", `${bundlePath}/Contents/Info.plist`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      entry[key] = "";
    }
  }
  return entry[key] || undefined;
}

/** The .app bundle an executable belongs to, and that bundle's ID. */
export function bundleOf(path: string): { bundlePath: string; bundleId?: string } | undefined {
  const i = path.indexOf(".app/Contents/MacOS/");
  if (i < 0) return undefined;
  const bundlePath = path.slice(0, i + 4);
  return { bundlePath, bundleId: plistValue(bundlePath, "CFBundleIdentifier") };
}

/** Parent PIDs of a process, nearest first, up to (not including) launchd. */
export function ancestors(pid: number): number[] {
  const out: number[] = [];
  for (let p = pid; p > 1 && out.length < 64; ) {
    let parent: number;
    try {
      parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(p)], { encoding: "utf8" }).trim());
    } catch {
      break;
    }
    if (!parent || parent <= 1) break;
    out.push(parent);
    p = parent;
  }
  return out;
}

/**
 * An "app" is a main app executable (one .app, not a helper nested inside another app) installed
 * where people install apps. Core UI like Finder and Dock lives in /System/Library, so it never
 * counts as an app and is never offered for closing.
 */
export function classify(path: string, tty: string, user: string): { kind: Kind; name: string } {
  const app = path.match(/^(?:\/Applications|\/System\/Applications|\/Users\/[^/]+\/Applications)\/(?:[^/]+\/)*?([^/]+)\.app\/Contents\/MacOS\/[^/]+$/);
  const userApps = `/Users/${user}/Applications/`;
  const inAppsFolder = !path.startsWith("/Users/") || path.startsWith(userApps);
  if (app && inAppsFolder && path.split(".app/").length === 2) {
    // Only the bundle's main executable counts; helpers in the same MacOS folder are background.
    const bundle = bundleOf(path)!;
    const main = plistValue(bundle.bundlePath, "CFBundleExecutable");
    if (!main || path === `${bundle.bundlePath}/Contents/MacOS/${main}`) return { kind: "app", name: app[1] };
  }
  const name = path.split("/").pop() || path;
  return { kind: tty && tty !== "??" ? "script" : "background", name };
}

export function listProcesses(user: string): Proc[] {
  const out = execFileSync("ps", ["-U", user, "-o", "pid=,ppid=,tty=,etime=,comm="], { encoding: "utf8" });
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, pid, ppid, tty, etime, path] = m;
    const { kind, name } = classify(path.trim(), tty, user);
    procs.push({ pid: Number(pid), ppid: Number(ppid), name, path: path.trim(), kind, ageSeconds: parseElapsed(etime) });
  }
  // An app that forks copies of itself (e.g. Docker's backend) counts once: copies are background.
  const pathByPid = new Map(procs.map((p) => [p.pid, p.path]));
  for (const p of procs) if (p.kind === "app" && pathByPid.get(p.ppid) === p.path) p.kind = "background";
  return procs.sort((a, b) => b.ageSeconds - a.ageSeconds);
}

// ---- Scripts: programs the user started (python, java, node, shell scripts…), not apps or macOS itself.

export type ScriptStatus = "yours" | "protected" | "service" | "part of app";

export interface Script extends Proc {
  cpu: number;
  memMB: number;
  /** Command line with likely secrets removed and trimmed; the only form shown to the model. */
  command: string;
  status: ScriptStatus;
  /** For "part of app": that app's name. For "service": its launchd label. */
  owner?: string;
  flags: string[];
}

const SYSTEM_DIRS = /^\/(System|usr\/libexec|usr\/sbin|usr\/bin|bin|sbin|Library\/Apple)\//;
const SHELL = /^\/bin\/(bash|zsh|sh|dash|ksh|tcsh|csh)$/;

/** Hide likely secrets (key=…, --token …, long key-like strings) and trim to ~80 characters. */
export function redact(args: string): string {
  // Show the program by name, not its full path, so the arguments (what it's actually doing) fit.
  const out = args
    .replace(/^\/\S*\/([^/\s]+)(?=\s|$)/, "$1")
    .replace(/((?:^|[\s-])[\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth)[\w.-]*[=:\s]+)\S+/gi, "$1…")
    .replace(/[A-Za-z0-9_\-+=]{32,}/g, "…"); // long key-like runs (paths split on "/", so they survive)
  return out.length > 80 ? out.slice(0, 79) + "…" : out;
}

/** launchd-managed PIDs for the current user, with their labels (only our own account can be queried). */
function launchdServices(): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const out = execFileSync("launchctl", ["list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n").slice(1)) {
      const [pid, , label] = line.split("\t");
      if (/^\d+$/.test(pid)) map.set(Number(pid), label);
    }
  } catch {}
  return map;
}

/**
 * The account's scripts. `protectedPids` are processes that must never be stopped (the agent itself);
 * pass `checkServices` only for the account this server runs as.
 */
export function listScripts(user: string, protectedPids: Set<number>, checkServices: boolean): Script[] {
  const procs = listProcesses(user);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const extra = new Map<number, { cpu: number; memMB: number; args: string }>();
  const out = execFileSync("ps", ["-U", user, "-o", "pid=,%cpu=,rss=,args="], { encoding: "utf8" });
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (m) extra.set(Number(m[1]), { cpu: Number(m[2]), memMB: Math.round(Number(m[3]) / 1024), args: m[4] });
  }
  const ttyByPid = new Map<number, string>();
  for (const line of execFileSync("ps", ["-U", user, "-o", "pid=,tty="], { encoding: "utf8" }).split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)/);
    if (m) ttyByPid.set(Number(m[1]), m[2]);
  }
  const services = checkServices ? launchdServices() : new Map<number, string>();

  const isScript = (p: Proc, args: string) => {
    if (p.kind === "app") return false;
    if (/\/Python[0-9.]*\.(framework|app)\//.test(p.path)) return true; // python.org / Homebrew / Xcode Python
    if (p.path.startsWith("-") || p.path === "login") return false; // login shells: Terminal tabs
    if (SHELL.test(p.path) || /^(bash|zsh|sh|dash|ksh|tcsh|csh)$/.test(p.path)) {
      // A shell running a script file counts; interactive shells (Terminal tabs) don't.
      const words = args.split(/\s+/);
      return !words[0].startsWith("-") && words.slice(1).some((w) => w && !w.startsWith("-"));
    }
    if (SYSTEM_DIRS.test(p.path)) return false;
    // App, XPC and framework helpers (e.g. Xcode's SourceKitService) belong to whatever ships them.
    return !/\.(app|xpc|framework)\//.test(p.path);
  };

  const scripts: Script[] = [];
  for (const p of procs) {
    const x = extra.get(p.pid);
    if (!x || !isScript(p, x.args)) continue;
    const hasTty = (ttyByPid.get(p.pid) ?? "??") !== "??";

    let status: ScriptStatus = "yours";
    let owner: string | undefined;
    if (protectedPids.has(p.pid)) status = "protected";
    else if (services.has(p.pid)) [status, owner] = ["service", services.get(p.pid)];
    else if (!hasTty && p.ppid !== 1) {
      // Started by something without a terminal: find the app (if any) it belongs to.
      // Walk up the parents: a terminal ancestor means the user started it; an app ancestor owns it.
      for (let a = byPid.get(p.ppid), n = 0; a && n < 32; a = byPid.get(a.ppid), n++) {
        if ((ttyByPid.get(a.pid) ?? "??") !== "??") break;
        const bundle = bundleOf(a.path);
        if (a.kind === "app" || bundle) {
          status = "part of app";
          owner = a.kind === "app" ? a.name : bundle!.bundlePath.split("/").pop()!.replace(/\.app$/, "");
          break;
        }
      }
    }
    const flags: string[] = [];
    if (p.ppid === 1 && status === "yours") flags.push(checkServices ? "orphaned" : "orphaned?");
    if (x.cpu > 50 || x.memMB > 1024) flags.push("heavy");
    scripts.push({ ...p, cpu: x.cpu, memMB: x.memMB, command: redact(x.args), status, owner, flags });
  }
  // Duplicates: the same full command line running more than once.
  const counts = new Map<string, number>();
  for (const s of scripts) counts.set(extra.get(s.pid)!.args, (counts.get(extra.get(s.pid)!.args) ?? 0) + 1);
  for (const s of scripts) if (counts.get(extra.get(s.pid)!.args)! > 1) s.flags.push("duplicate");
  return scripts;
}
