// iMessage bridge for the menu bar app, over Photon Spectrum (their hosted iMessage line): prints each
// text the user sends to the agent's number as a JSON line on stdout; reads JSON lines on stdin and
// texts them back, optionally with a screenshot of the agent's screen. The AI never talks to this
// process. Exits when stdin closes, so it never outlives the app that started it.


import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// The parts of a Spectrum space (a conversation) the bridge uses
export type Space = { type?: string; send(content: unknown): Promise<unknown> };

// The parts of a Spectrum message the bridge reads

export type Incoming = {
  id: string;
  direction: string;
  sender?: { id: string; service?: string };
  content: { type: string; text?: string };
  timestamp: Date;
};

/** The parts of a Spectrum app the bridge uses, so tests can pass a stub. */
export type App = { messages: AsyncIterable<[Space, Incoming]>; stop(): Promise<void> };

/** Phone numbers compare by digits, emails by lowercase. */
export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  return h.includes("@") ? h : h.replace(/\D/g, "");
}

function sameHandle(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes("@") || b.includes("@")) return false;
  // "+1 555 123 4567" and "5551234567" are the same phone.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 10 && long.endsWith(short);
}

export function taskText(m: Incoming): string {
  return (m.content.text ?? "").trim();
}

// returns first reason for rejection, or null if the message is acceptable. Not the best but is simple enough for an mvp
export function rejectReason(m: Incoming, space: Space, handles: string[], startedAt: number, seen: Set<string>): string | null {
  if (m.direction !== "inbound") return "not an incoming message";
  if (space.type !== "dm") return "not a one-to-one chat";
  const who = normalizeHandle(m.sender?.id ?? "");
  if (!handles.some((h) => sameHandle(h, who))) return "not from the user";
  if (m.sender?.service !== "iMessage") return "not an iMessage";
  if (m.content.type !== "text" || !taskText(m)) return "not a text";
  if (m.timestamp.getTime() < startedAt) return "sent before the bridge started";
  if (seen.has(m.id)) return "already handled";
  return null;
}

export type BridgeOptions = {
  app: App;
  // The user's own handles 
  handles: string[];
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  screenshot: () => Promise<Buffer>;
  // Turns a PNG into something a space can read
  image: (png: Buffer) => unknown;
  startedAt?: number;
};

export async function runBridge({ app, handles, input, output, screenshot, image, startedAt = Date.now() }: BridgeOptions) {
  const own = handles.map(normalizeHandle).filter(Boolean); //remove falsy vals from norlizedhndle
  const seen = new Set<string>(); 
  const emit = (line: Record<string, unknown>) => void output.write(JSON.stringify(line) + "\n");
  const fail = (what: string, e: unknown) => emit({ type: "error", message: `${what}: ${(e as Error).message}` });
  

  //log basic info without full sender id or msg content. Logic corrected by Claude Code  
  const note = (space: Space, m: Incoming, outcome: string) => {
    const from = (m.sender?.id ?? "nobody").replace(/^.*(?=.{4}$)/, "…"); //can't beleive I don't remember Regex well. But I understand that it is a privacy measure
    //claude's genius to write to stderr
    process.stderr.write(
      `${outcome}: from ${from}, service ${m.sender?.service ?? "none"}, ${m.direction} ${m.content.type} in a ${space.type ?? "?"} chat, sent ${m.timestamp.toISOString()}\n`,
    );
  };

  //The user's conversation, known once they have sent a task. Replies go here.
  let thread: Space | undefined;

  const watching = (async () => {
    try {
      for await (const [space, m] of app.messages) {
        const why = rejectReason(m, space, own, startedAt, seen);
        if (why === "not an iMessage") {
          emit({ type: "error", message: "Ignored a text from your number because it wasn't sent as an iMessage (blue bubble)." });
        }
        note(space, m, why ? `ignored (${why})` : "task");
        if (why) continue;
        seen.add(m.id);
        thread = space;
        emit({ type: "task", text: taskText(m) });
      }
      process.stderr.write("the stream of texts from Photon ended\n");
    } catch (e) {
      fail("Receiving texts failed", e);
    }
  })();

  // Signal that we're ready to receive tasks.
  emit({ type: "ready" });

  async function reply(text: string, withScreenshot: boolean) {
    if (!thread) return fail("Couldn't send the reply", new Error("no text has arrived yet, so there is nowhere to reply"));
    try {
      await thread.send(text);
    } catch (e) {
      return fail("Couldn't send the reply", e);
    }
    if (!withScreenshot) return;
    try {
      await thread.send(image(await screenshot()));
    } catch (e) {
      fail("Couldn't send the screenshot", e);
    }
  }

  // One reply at a time, in the order they were asked for.
  let sending = Promise.resolve();
  for await (const line of createInterface({ input })) {
    let msg: { type?: string; text?: unknown; screenshot?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type !== "reply" || typeof msg.text !== "string" || !msg.text.trim()) continue;
    const text = msg.text.trim();
    const withScreenshot = msg.screenshot === true;
    sending = sending.then(() => reply(text, withScreenshot));
  }
  await sending;
  await app.stop();
  await watching;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handles = (process.env.MAC_AGENT_IMESSAGE_HANDLE ?? "").split(",").filter((h) => normalizeHandle(h));
  const projectId = process.env.SPECTRUM_PROJECT_ID ?? "";
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET ?? "";
  const die = (message: string): never => {
    process.stdout.write(JSON.stringify({ type: "error", message }) + "\n");
    process.exit(1);
  };
  if (!handles.length) die("Set MAC_AGENT_IMESSAGE_HANDLE to your own iMessage number or email.");
  if (!projectId || !projectSecret) die("Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET (Photon dashboard → project Settings).");
  process.stdout.on("error", () => process.exit(0)); // reader went away (EPIPE)

  const screen = await import("./screen.js");
  try {
    const { Spectrum, attachment } = await import("@spectrum-ts/core");
    const { imessage } = await import("@spectrum-ts/imessage");
    const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()], options: { logLevel: "error" } });
    await runBridge({
      app: app as unknown as App,
      handles,
      input: process.stdin,
      output: process.stdout,
      image: (png) => attachment(png, { mimeType: "image/png", name: "agent-screen.png" }),
      screenshot: async () => {
        try {
          return (await screen.screenshot()).png;
        } finally {
          screen.disconnect(); 
        }
      },
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    die(
      (err.status != null && err.status >= 400 && err.status < 500) || /"type":"validation"/.test(err.message)
        ? "Photon didn't accept the project ID and secret. ⌥-click the button to enter them again."
        : `Couldn't connect to Photon: ${err.message}`,
    );
  }
  process.exit(0);
}
