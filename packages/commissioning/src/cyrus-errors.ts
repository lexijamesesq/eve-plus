const reasons = {
  invalid_configuration: "Invalid Cyrus connector configuration",
  invalid_reference: "A Linear issue reference is required",
  invalid_binding: "Invalid Cyrus work binding",
  contract_too_large: "The Cyrus commissioning contract exceeds the supported size",
  configuration_changed: "Cyrus configuration differs from the recorded work binding",
  work_unavailable: "The canonical Linear work record is unavailable",
  handoff_conflict: "The Linear work record conflicts with this commission",
  handoff_unconfirmed: "The Cyrus handoff is not confirmed",
  provider_unavailable: "The Linear provider is unavailable",
  cancelled: "The Cyrus request was cancelled",
  timeout: "The Cyrus request timed out",
} as const;

const transient: ReadonlySet<keyof typeof reasons> = new Set(["provider_unavailable", "timeout"]);

export class CyrusConnectorError extends Error {
  /** Whether trying again later may succeed: the provider was unreachable or slow, not the request refused. */
  readonly retryable: boolean;
  constructor(public readonly code: keyof typeof reasons) {
    super(reasons[code]);
    this.name = "CyrusConnectorError";
    this.retryable = transient.has(code);
  }
}

export function failCyrus(code: keyof typeof reasons): never {
  throw new CyrusConnectorError(code);
}
