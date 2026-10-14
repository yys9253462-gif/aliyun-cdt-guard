import { AsyncLocalStorage } from "node:async_hooks";

function requestContext() {
  return scopes.getStore() || legacy;
}
function withRequestContext(fn, extras = {}) {
  return scopes.run({ ...create(), ...extras }, fn);
}
function withOperationSignal(signal, fn) {
  return scopes.run({ ...requestContext(), signal }, fn);
}
function throwIfCancelled() {
  requestContext().signal?.throwIfAborted();
}
function operationSignal(timeoutMs = 15e3) {
  const parent = requestContext().signal;
  return parent ? AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
function sleep(ms) {
  const signal = requestContext().signal;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
var scopes, create, legacy;
scopes = new AsyncLocalStorage();
create = () => ({ budget: { used: 0 }, balanceCache: /* @__PURE__ */ new Map(), signal: null, actionJournal: null });
legacy = create();

export { create, legacy, operationSignal, requestContext, scopes, sleep, throwIfCancelled, withOperationSignal, withRequestContext };
