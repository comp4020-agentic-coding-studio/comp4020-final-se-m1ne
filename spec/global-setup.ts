import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
  }
}

// A dedicated port and database, never the ones a locally-running dev server
// uses (server/index.js defaults to port 8080 and DB_PATH /data/app.db) --
// see below for why that separation has to be permanent, not a convention.
const TEST_PORT = 8099;

async function waitFor(baseUrl: string, describe: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(baseUrl);
      return;
    } catch {
      // not up yet
    }
    if (attempt >= 300) {
      throw new Error(`nothing answered at ${baseUrl} after 60s (${describe})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// Confirms the server we just spawned ourselves is the one that came up on
// our port -- by matching its own stdout, not by probing the port with
// fetch. A plain port probe can't tell a freshly-spawned process apart from
// some unrelated thing that already happened to be listening there, which
// would silently defeat the whole point of spawning an isolated instance: if
// the port is already taken, that MUST fail loudly, never fall through to
// quietly testing against whatever else answers.
function waitForOwnServer(child: ChildProcess, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(`listening on ${port}`)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `the test server process exited before reporting it was listening (code ${code}, signal ${signal}) -- ` +
            `port ${port} may already be in use by something else.\n${output}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`test server never reported listening on port ${port} within 60s.\n${output}`));
    }, 60_000);
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
}

// The spec checks a RUNNING app over HTTP, so it holds whatever the app is
// built with. CI builds the Dockerfile and starts the image with a throwaway
// `--tmpfs /data`, so every CI run already gets a disposable database — set
// APP_URL and that path is used as-is, unchanged.
//
// Locally, with no APP_URL, this used to mean "whatever's already running at
// localhost:8080" -- which, by default, is the exact same server and the same
// on-disk database (DB_PATH's default, /data/app.db) a developer's own
// `pnpm start` session uses to look at the canvas in a browser while working.
// Every `pnpm check` run then wrote its throwaway test strokes straight into
// that persistent canvas, permanently and invisibly cluttering it with test
// fixtures no developer asked to see. Spawning our own isolated instance --
// its own port, its own throwaway database directory, torn down when the run
// ends -- makes that impossible by construction instead of by convention: a
// developer's manual dev session is never the thing `pnpm check` talks to
// unless they explicitly opt in by setting APP_URL themselves.
export default async function setup(project: TestProject): Promise<void | (() => Promise<void>)> {
  if (process.env.APP_URL) {
    await waitFor(process.env.APP_URL, "set APP_URL to where your app is listening");
    project.provide("baseUrl", process.env.APP_URL);
    return;
  }

  const baseUrl = `http://localhost:${TEST_PORT}`;
  const dbDir = mkdtempSync(join(tmpdir(), "comp4020-test-db-"));
  const dbPath = join(dbDir, "app.db");

  const child = spawn("node", ["server/index.js"], {
    cwd: project.config.root,
    env: { ...process.env, PORT: String(TEST_PORT), DB_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForOwnServer(child, TEST_PORT);
  } catch (err) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(dbDir, { recursive: true, force: true });
    throw err;
  }

  project.provide("baseUrl", baseUrl);

  return async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    rmSync(dbDir, { recursive: true, force: true });
  };
}
