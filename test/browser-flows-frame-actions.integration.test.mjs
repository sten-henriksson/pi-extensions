import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { AgentBrowser } from "../extensions/browser-flows/runner.ts";

const available = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;

function piExec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

const pages = {
  "/": `<!doctype html><title>Parent</title><h1>Shell</h1><iframe id="content" src="/person"></iframe>`,
  "/person": `<!doctype html><h1>Personuppgifter</h1><button id="NewPers" onclick="window.open('/wizard','ny-person')">Ny person</button>`,
  "/wizard": `<!doctype html><h1>Ny person</h1><label>Personnummer <input id="personnummer"></label><button id="cancel" onclick="window.close()">Avbryt</button>`,
};

test("durable actions drive a real same-origin iframe and popup cleanup", { skip: !available, timeout: 30_000 }, async () => {
  const server = createServer((request, response) => {
    const body = pages[request.url] ?? "not found";
    response.writeHead(pages[request.url] ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const session = `frame-actions-${Date.now()}`;
  const browser = new AgentBrowser({ exec: piExec });
  const globals = ["--session", session];
  const run = async (...args) => {
    const result = await browser.execute(globals, args);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  try {
    await run("open", `http://127.0.0.1:${address.port}/`);
    await run("frame-assert-text", "iframe#content", "Personuppgifter");
    await run("frame-click", "iframe#content", "#NewPers");
    await run("tab-switch-url", "**/wizard");
    assert.match(await run("get", "text", "body"), /Personnummer/);
    assert.equal((await run("get", "value", "#personnummer")).trim(), "");
    await run("click-visible", "#cancel");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.doesNotMatch(await run("tab"), /\/wizard/);
    await run("frame-assert-text", "iframe#content", "Personuppgifter");
  } finally {
    await browser.execute(globals, ["close"]).catch(() => undefined);
    await new Promise(resolve => server.close(resolve));
  }
});
