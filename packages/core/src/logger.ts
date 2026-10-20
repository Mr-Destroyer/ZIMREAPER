export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** Structured stderr logger. Never logs secrets; callers pass only safe fields. */
export function createLogger(_scope: string): Logger {
  const emit = (level: string, msg: string, fields?: Record<string, unknown>) => {
    if (process.env.ZIMREAPER_LOG === "silent") return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, scope: _scope, msg, ...fields });
    process.stderr.write(line + "\n");
  };
  const logger: Logger = {
    debug: (m, f) => {
      if (process.env.ZIMREAPER_LOG === "debug") emit("debug", m, f);
    },
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (s) => createLogger(`${_scope}:${s}`),
  };
  return logger;
}
