# Eve-Plus Sandbox: microsandbox

A sandbox provider for [eve](https://github.com/vercel/eve) that runs each session in its own [microsandbox](https://github.com/superradcompany/microsandbox) microVM, deny-all by default. It's built on eve's public `defineSandboxProvider` seam (`eve/sandbox/provider`), so it uses no eve internals.

> Work in progress: this release carries the network-policy contract. The provider itself lands next.

## Network policy

The provider enforces exactly two policies, set once when a session's sandbox starts. Every other shape rejects with `UnsupportedNetworkPolicyError` rather than being weakened: microsandbox can't inject the headers eve's `transform` rules add, and can't change a live sandbox's policy.

An absent policy means `deny-all`. eve's Docker provider defaults to `allow-all`; this one doesn't.

The table below is checked by the package's unit tests: each row's shape is parsed as JSON and must produce its result.

| Shape                                                                                    | Result      |
| ---------------------------------------------------------------------------------------- | ----------- |
| absent                                                                                   | `deny-all`  |
| `"deny-all"`                                                                             | `deny-all`  |
| `"allow-all"`                                                                            | `allow-all` |
| `{}`                                                                                     | rejects     |
| `{"allow": ["*"]}`                                                                       | rejects     |
| `{"allow": {"*": []}}`                                                                   | rejects     |
| `{"allow": ["example.com"]}`                                                             | rejects     |
| `{"allow": {"github.com": [{"transform": [{"headers": {"a": "b"}}]}]}}`                  | rejects     |
| `{"allow": {"github.com": [{"forwardURL": "https://proxy.internal"}]}}`                  | rejects     |
| `{"allow": {"github.com": [{"match": {"method": ["GET"]}, "forwardURL": "https://p"}]}}` | rejects     |
| `{"subnets": {"allow": ["10.0.0.0/8"]}}`                                                 | rejects     |
| `{"subnets": {"deny": ["10.0.0.0/8"]}}`                                                  | rejects     |
| `"DENY-ALL"`                                                                             | rejects     |
| `null`                                                                                   | rejects     |
