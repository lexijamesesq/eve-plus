import { resolveRuntime, resolveRuntimeVersion } from "microsandbox";

/** The microsandbox release this package pins, SDK and runtime alike. */
export const MICROSANDBOX_VERSION = "0.7.10";

/** Thrown when the msb runtime isn't the one the locked platform package ships. */
export class MicrosandboxRuntimeMismatchError extends Error {
  override readonly name = "MicrosandboxRuntimeMismatchError";
}

/**
 * Fails unless msb resolves from the locked platform package at the pinned version. Any other
 * origin, such as an older runtime installed under MSB_HOME or an MSB_PATH override, would run
 * a VM monitor this package wasn't proven against.
 */
export async function assertPinnedRuntime(): Promise<void> {
  const runtime = resolveRuntime();
  const version = await resolveRuntimeVersion(runtime.msbPath);
  if (runtime.origin !== "sdk_package" || version !== MICROSANDBOX_VERSION) {
    throw new MicrosandboxRuntimeMismatchError(
      `The microsandbox runtime must come from the locked platform package at ${MICROSANDBOX_VERSION}, ` +
        `but resolved ${runtime.msbPath} (origin "${runtime.origin}", version ${version ?? "unknown"}). ` +
        "Remove the overriding runtime or install @eve-plus/sandbox-microsandbox's pinned microsandbox.",
    );
  }
}
