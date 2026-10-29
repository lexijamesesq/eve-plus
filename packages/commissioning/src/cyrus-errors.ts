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

export class CyrusConnectorError extends Error {
  constructor(public readonly code: keyof typeof reasons) {
    super(reasons[code]);
    this.name = "CyrusConnectorError";
  }
}

export function failCyrus(code: keyof typeof reasons): never {
  throw new CyrusConnectorError(code);
}
