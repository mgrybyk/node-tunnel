#ifndef NODE_TUNNEL_CLIENT_H
#define NODE_TUNNEL_CLIENT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct nt_client nt_client;

enum nt_client_operation {
    NT_CLIENT_REGISTER = 1,
    NT_CLIENT_DISCONNECT = 2,
    NT_CLIENT_CONTROL_FRAME = 3,
    NT_CLIENT_OPEN_TUNNEL = 4,
    NT_CLIENT_PING = 5,
    NT_CLIENT_DATA_PREFACE = 6,
    NT_CLIENT_DATA_FRAME = 7,
    NT_CLIENT_CANCEL = 8
};

enum nt_client_result {
    NT_CLIENT_REJECTED = -1,
    NT_CLIENT_INVALID_ARGUMENT = -2,
    NT_CLIENT_PANICKED = -3
};

enum nt_client_action {
    NT_CLIENT_SEND_FRAME = 1,
    NT_CLIENT_EVENT = 2
};

size_t nt_client_buffer_capacity(void);
size_t nt_client_max_frame_bytes(void);

/* key is 32 bytes; name is length-delimited UTF-8; port_count is 1 through 32.
 * out_client points to separate writable storage. It receives NULL on failure.
 * Returns 0 on success, or a negative nt_client_result. Inputs are borrowed only
 * during the call. The returned handle must be destroyed with nt_client_destroy. */
int32_t nt_client_create(const uint8_t *key, size_t key_length,
                         const uint8_t *name, size_t name_length,
                         uint32_t port_count, nt_client **out_client);

/* Supply a live handle, non-overlapping input/output buffers, and at least
 * nt_client_buffer_capacity() writable output bytes. Input may be NULL when
 * input_length is zero. Returns a positive byte count (action tag + payload),
 * 0 for no action, or a negative nt_client_result. Output is caller-owned and
 * only the returned bytes are written. Calls on a handle are serialized by the
 * library; callers must order events and wait for all calls before destruction.
 * After NT_CLIENT_PANICKED, destroy the handle and create a new one. */
int32_t nt_client_step(nt_client *client, uint32_t operation,
                       const uint8_t *input, size_t input_length,
                       uint8_t *output, size_t output_capacity);

/* Consumes a live handle exactly once, or accepts NULL as a no-op. Returns 0
 * on success, or NT_CLIENT_PANICKED. The handle is invalid after the call. */
int32_t nt_client_destroy(nt_client *client);

#ifdef __cplusplus
}
#endif

#endif
