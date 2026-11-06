import { MicrosandboxSandbox } from "@eve-plus/sandbox-microsandbox";
import { defineSandbox } from "eve/sandbox";

export const environment = MicrosandboxSandbox.environment({});

export default defineSandbox(() => environment.open());
