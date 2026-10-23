export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const response = "response" in error ? error.response : undefined;
    if (typeof response === "object" && response !== null && "data" in response) {
      const data = response.data;
      if (typeof data === "object" && data !== null) {
        const record = data as {
          error?: { message?: string };
          errors?: { detail?: string }[];
        };
        const apiMessage = record.error?.message ?? record.errors?.map((item) => item.detail).filter(Boolean).join("; ");
        if (apiMessage) return apiMessage;
      }
      if (typeof data === "string" && data.trim()) return data;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return "Falha desconhecida";
}
