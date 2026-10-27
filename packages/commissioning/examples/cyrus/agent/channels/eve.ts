import { eveChannel } from "eve/channels/eve";
import { ownerRouteAuth } from "../lib/identity.js";
export default eveChannel({ auth: ownerRouteAuth });
