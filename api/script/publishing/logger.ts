type ObjectOrMessage = string | Error | Record<string, unknown>;

function write(level: "info" | "warn" | "error", objectOrMessage: ObjectOrMessage, message?: string): void {
  const text = typeof objectOrMessage === "string" ? objectOrMessage : message || "";
  const detail = typeof objectOrMessage === "string" ? undefined : objectOrMessage;
  if (level === "error") {
    console.error(text, detail ?? "");
    return;
  }
  if (level === "warn") {
    console.warn(text, detail ?? "");
    return;
  }
  console.log(text, detail ?? "");
}

export const logger = {
  info: (objectOrMessage: ObjectOrMessage, message?: string) => write("info", objectOrMessage, message),
  warn: (objectOrMessage: ObjectOrMessage, message?: string) => write("warn", objectOrMessage, message),
  error: (objectOrMessage: ObjectOrMessage, message?: string) => write("error", objectOrMessage, message),
};
