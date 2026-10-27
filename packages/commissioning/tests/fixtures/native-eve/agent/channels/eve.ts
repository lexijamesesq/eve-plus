import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
// Fixture-only access for native session stream evidence; never estate credentials.
export default eveChannel({ auth: httpBasic({ username: "fixture", password: "fixture-only" }) });
