import assert from "node:assert/strict";
import test from "node:test";
import { AgentBrowser } from "../extensions/browser-flows/runner.ts";

function browserWith(handler) {
  const calls = [];
  const pi = {
    async exec(command, args, options) {
      calls.push({ command, args, options });
      return handler(command, args, options, calls.length);
    },
  };
  return { browser: new AgentBrowser(pi), calls };
}

const ok = (stdout = "ok") => ({ code: 0, stdout, stderr: "" });

test("frame-click translates durable selectors into fixed same-origin script", async () => {
  const { browser, calls } = browserWith(() => ok("clicked"));
  const result = await browser.execute(["--session", "fixture"], ["frame-click", "iframe#content", "#NewPers"]);
  assert.equal(result.code, 0);
  assert.deepEqual(calls[0].args.slice(0, 3), ["--session", "fixture", "eval"]);
  const script = calls[0].args[3];
  assert.match(script, /HTMLIFrameElement/);
  assert.match(script, /iframe#content/);
  assert.match(script, /#NewPers/);
  assert.doesNotMatch(script, /@e\d+/);
});

test("frame-select-text chooses an exact option and dispatches change", async () => {
  const { browser, calls } = browserWith(() => ok("selected"));
  const result = await browser.execute([], ["frame-select-text", "iframe#content", "select#company", "Approved Test"]);
  assert.equal(result.code, 0);
  assert.equal(calls[0].args[0], "eval");
  assert.match(calls[0].args[1], /HTMLSelectElement/);
  assert.match(calls[0].args[1], /Approved Test/);
  assert.match(calls[0].args[1], /change/);
  assert.doesNotMatch(calls[0].args[1], /@e\d+/);
});

test("click-visible and frame-assert-text use constrained fixed scripts", async () => {
  const { browser, calls } = browserWith(() => ok());
  await browser.execute([], ["click-visible", "input[value='Avbryt']"]);
  await browser.execute([], ["frame-assert-text", "iframe#content", "Personuppgifter"]);
  assert.equal(calls[0].args[0], "eval");
  assert.match(calls[0].args[1], /getClientRects/);
  assert.deepEqual(calls[1].args.slice(0, 2), ["wait", "--fn"]);
  assert.match(calls[1].args[2], /contentDocument/);
});

test("tab-switch-url waits for one matching popup and switches by stable tab id", async () => {
  let listings = 0;
  const { browser, calls } = browserWith((_command, args) => {
    const localArgs = args.filter((arg) => arg !== "--session" && arg !== "fixture");
    if (localArgs[0] === "tab" && localArgs.length === 1) {
      listings += 1;
      return ok(listings === 1
        ? "→ [t1] Parent - https://example.test/app"
        : "[t1] Parent - https://example.test/app\n→ [t7] Wizard - https://example.test/Personwiz_light1.asp?new=yes");
    }
    if (localArgs[0] === "tab" && localArgs[1] === "t7") return ok("switched");
    return { code: 1, stdout: "", stderr: `unexpected ${localArgs.join(" ")}` };
  });
  const result = await browser.execute(
    ["--session", "fixture"],
    ["tab-switch-url", "**/Personwiz_light1.asp?new=yes"],
  );
  assert.equal(result.code, 0);
  assert.equal(listings, 2);
  assert.deepEqual(calls.at(-1).args.slice(-2), ["tab", "t7"]);
});

test("durable actions reject missing arguments", async () => {
  const { browser } = browserWith(() => ok());
  await assert.rejects(() => browser.execute([], ["frame-click", "iframe"]), /requires/);
  await assert.rejects(() => browser.execute([], ["frame-select-text", "iframe", "select"]), /requires/);
  await assert.rejects(() => browser.execute([], ["tab-switch-url"]), /requires/);
});
