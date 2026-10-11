// Use case: Permission to close scripts in the user's tab
//cause asking is polite


import { execFile } from "node:child_process";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function osascript(script: string, args: string[], timeoutMs: number): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script, ...args], { timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ out: stdout.trim(), err: stderr.trim(), code });
    });
  });
}

const ASK = `on run argv
  set msg to "The agent wants to " & item 1 of argv & " (" & item 2 of argv & ")." & return & return & item 3 of argv
  activate
  set r to display dialog msg with title "Mac Agent" buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution giving up after 60
  if gave up of r then return "timeout"
  return button returned of r
end run`;

/**
 * Show the approval dialog on the user's screen: "The agent wants to <action> (<details>)." then <note>.
 * Anything but a click on Allow is a no.
 */
export async function askPermission(action: string, details: string, note: string): Promise<"allow" | "deny" | "timeout"> {
  const { out } = await osascript(ASK, [action, details, note], 75_000);
  if (out === "Allow") return "allow";
  if (out === "timeout") return "timeout";
  return "deny"; // Deny is the cancel button, which exits with an error and no output
}

const QUIT = `on run argv
  with timeout of 120 seconds
    tell application id (item 1 of argv) to quit
  end timeout
end run`;

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type QuitResult = { status: "closed" | "still_open" | "blocked" | "error"; detail?: string };

/** Quit an app the normal way (like cmd+q), then check whether its process is gone. */
export async function quitApp(bundleId: string, pid: number): Promise<QuitResult> {
  const { err, code } = await osascript(QUIT, [bundleId], 130_000);
  if (code !== 0 && /-1743|not allowed|Not authorized/i.test(err)) return { status: "blocked", detail: err };
  for (let i = 0; i < 20; i++) {
    if (!running(pid)) return { status: "closed" };
    await sleep(500);
  }
  if (code !== 0 && !/-128/.test(err)) return { status: "error", detail: err };
  return { status: "still_open" };
}

/** Ask a script of the user's to stop (SIGTERM), then check for up to 10 s. Never forces it. */
export async function stopScript(pid: number): Promise<"stopped" | "still_running"> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return "stopped";
    throw e;
  }
  for (let i = 0; i < 20; i++) {
    if (!running(pid)) return "stopped";
    await sleep(500);
  }
  return "still_running";
}
