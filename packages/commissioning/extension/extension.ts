import { defineExtension } from "eve/extension";
import { configSchema } from "../src/config.js";
export default defineExtension({ config: configSchema });
