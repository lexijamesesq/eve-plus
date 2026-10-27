import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { respond } from "./lib/model.js";
export default defineAgent({ modelContextWindowTokens: 1000000, model: mockModel(respond) });
