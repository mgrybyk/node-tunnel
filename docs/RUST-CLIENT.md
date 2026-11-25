# Rust client core

The `rust/` crate provides the node-tunnel v9 client protocol for future
Android and iOS hosts. It owns wire encoding, authenticated encryption,
registration, heartbeats, and tunnel negotiation. The host owns secure nonce
generation, TCP/TLS sockets, timers, and forwarding. Only control and setup
frames go through the protocol core. After readiness, forward any payload
bytes coalesced with that frame and pipe subsequent traffic in the host.

The desktop app runs from a fresh checkout with Node.js and its JavaScript
backend. The compiled Rust libraries and WASM module are excluded from the
npm package. The WASM adapter is exercised in CI against the current JavaScript
peers.

## Build and test

From the repository root with Rustup installed, run the native tests and build
the shared and static libraries in `rust/target/release`. The toolchain file
selects stable Rust. The library base name is `node_tunnel_client`.

```sh
cd rust
cargo test --locked
cargo build --locked --release
```

On Linux or macOS, from the `rust` directory, a C compiler can link and invoke
the native API using the same smoke test as CI.

```sh
cc -std=c11 -Wall -Wextra -Werror -Iinclude tests/native_smoke.c \
  -Ltarget/release -lnode_tunnel_client -Wl,-rpath,"$PWD/target/release" -o target/native-smoke
target/native-smoke
```

From the repository root, build the WASM adapter and run the compatibility
suite. The TLS test requires OpenSSL on `PATH`.

```sh
npm run build:wasm
npm run test:rust
```

The Rust interoperability suite uses the WASM adapter and enables
`N_T_CLIENT_PROTOCOL_BACKEND=wasm` for its test process.
That exact value also enables the experiment in a source checkout after the
module has been built. The WASM exports, operation IDs, and exchange buffer
contract remain compatible with the Node adapter.

## Native C ABI

Use [node_tunnel_client.h](../rust/include/node_tunnel_client.h) as the binding
definition. Create one handle per client session with the shared control key
bytes, a UTF-8 route name, and the number of advertised ports. Keep the same
handle across control reconnects so it can reuse the relay-issued UUID. Call
`nt_client_destroy` exactly once per live handle, after all calls using it have
finished. Handles have independent state. Calls on the same handle are
serialized internally, but the host determines event order.

The host owns input and output buffers and keeps them valid for each call.
Supply separate buffers and at least `nt_client_buffer_capacity()` writable
output bytes. `nt_client_step` returns the number of bytes written, including
the first-byte action tag. Tag `NT_CLIENT_SEND_FRAME` is followed by bytes to
write to the socket, including the LF delimiter. Tag `NT_CLIENT_EVENT` is
followed by UTF-8 JSON, with events such as `registration`, `open-data`, and
`start-forwarding`. Pass output lengths explicitly since no NUL terminator is
added.

| Operation                                         | Input                                                         |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `NT_CLIENT_REGISTER`, `NT_CLIENT_PING`            | 12-byte nonce                                                 |
| `NT_CLIENT_DISCONNECT`                            | Empty                                                         |
| `NT_CLIENT_CONTROL_FRAME`, `NT_CLIENT_DATA_FRAME` | One bounded wire frame without LF                             |
| `NT_CLIENT_OPEN_TUNNEL`                           | Nonce followed by UTF-8 JSON with `requestId` and `portIndex` |
| `NT_CLIENT_DATA_PREFACE`, `NT_CLIENT_CANCEL`      | Nonce followed by a UTF-8 JSON string containing the ticket   |

Use a fresh cryptographically secure nonce for every outbound frame under a
key. The receive frame limit is `nt_client_max_frame_bytes()`. Frame scanning,
socket selection, and execution of returned actions belong to the host.

Creation and destruction return `0` on success. For `nt_client_step`, `0`
means no action. Negative results distinguish protocol rejection (`-1`),
detectable argument errors (`-2`), and a caught Rust unwind or poisoned client
(`-3`). Destroy and recreate a client after `-3`. As with other C interfaces,
the caller must supply live handles and valid memory ranges. Process-aborting
failures, such as allocator exhaustion, cannot be returned as error codes.

The native ABI is tested on the host platform. Android and iOS cross-builds,
Dart FFI bindings, and app networking belong to the mobile project.
