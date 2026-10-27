import { requiredEnv } from "./env.js";
import { linear as originalLinear } from "./example-linear.js";
// Simulate only the external HTTP service. The installed connector builds every real request.
export const linear = {
  ...originalLinear,
  fetch: (async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://api.linear.app/graphql")
      throw new Error("Unexpected external destination");
    return fetch(new Request(requiredEnv("FIXTURE_LINEAR_URL"), request));
  }) as typeof fetch,
};
