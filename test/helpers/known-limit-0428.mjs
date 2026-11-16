// Match complete name paths: a child called "exact date" in an adverse arm must still run.
// Proxy the context so nested registrations use the same exact-name policy; bind native
// methods to their real context because node:test keeps private state on that receiver.
export function knownLimitTests(nodeTest, names, reason) {
  function register(run, parent, name, opts, fn) {
    const fullName = [...parent, name];
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    const callback = typeof fn === 'function' ? context => fn(new Proxy(context, {
      get(target, key) {
        if (key === 'test') return (name, opts, fn) => register(target.test.bind(target), fullName, name, opts, fn);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })) : fn;
    return run(name, names.has(fullName.join(' > ')) ? { ...opts, skip: reason } : opts, callback);
  }
  return Object.assign((name, opts, fn) => register(nodeTest, [], name, opts, fn), nodeTest);
}
