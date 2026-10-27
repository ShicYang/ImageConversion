import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/listener-scope.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { createListenerScope } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("unmount during asynchronous registration immediately releases the late subscription", async () => {
  const scope = createListenerScope();
  let completeRegistration;
  let activeListeners = 0;
  const pending = scope.register(new Promise((resolve) => { completeRegistration = resolve; }));
  scope.dispose();
  activeListeners++;
  completeRegistration(() => activeListeners--);
  await pending;
  assert.equal(activeListeners, 0);
  assert.equal(scope.disposed, true);
});

test("normal cleanup removes every subscription exactly once", async () => {
  const scope = createListenerScope();
  const removed = [];
  for (const name of ["resize", "progress", "drop"]) {
    await scope.register(Promise.resolve(() => removed.push(name)));
  }
  scope.dispose();
  scope.dispose();
  assert.deepEqual(removed, ["resize", "progress", "drop"]);
});

test("a failed registration can release already acquired subscriptions", async () => {
  const scope = createListenerScope();
  let activeListeners = 1;
  await scope.register(Promise.resolve(() => activeListeners--));
  await scope.register(Promise.reject(new Error("registration failed"))).catch(() => scope.dispose());
  assert.equal(activeListeners, 0);
});

test("cleanup from an old mount does not remove the new mount's listeners", async () => {
  const previous = createListenerScope();
  const current = createListenerScope();
  let activeListeners = 0;
  let completeOldRegistration;
  const pending = previous.register(new Promise((resolve) => { completeOldRegistration = resolve; }));
  previous.dispose();
  activeListeners++;
  await current.register(Promise.resolve(() => activeListeners--));
  activeListeners++;
  completeOldRegistration(() => activeListeners--);
  await pending;
  assert.equal(activeListeners, 1);
  current.dispose();
  assert.equal(activeListeners, 0);
});
