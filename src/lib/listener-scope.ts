/** Own event subscriptions even when registration finishes after the view unmounts. */
export function createListenerScope() {
  let disposed = false;
  const listeners: Array<() => void> = [];

  return {
    get disposed() { return disposed; },
    async register(registration: Promise<() => void>) {
      const unlisten = await registration;
      if (disposed) unlisten();
      else listeners.push(unlisten);
    },
    dispose() {
      disposed = true;
      for (const unlisten of listeners.splice(0)) unlisten();
    },
  };
}
