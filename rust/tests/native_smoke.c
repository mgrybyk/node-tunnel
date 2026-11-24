#include "node_tunnel_client.h"

#include <assert.h>
#include <stdlib.h>

int main(void) {
    const uint8_t key[] = "0123456789abcdef0123456789abcdef";
    const uint8_t name[] = "native-check";
    const uint8_t nonce[12] = {0};
    nt_client *first = NULL;
    nt_client *second = NULL;
    size_t capacity = nt_client_buffer_capacity();
    uint8_t *output = malloc(capacity);
    assert(output != NULL);
    assert(nt_client_max_frame_bytes() == 4096);
    assert(nt_client_create(key, sizeof(key) - 1, name, sizeof(name) - 1, 1, &first) == 0);
    assert(nt_client_create(key, sizeof(key) - 1, name, sizeof(name) - 1, 1, &second) == 0);
    assert(first != NULL && second != NULL && first != second);
    assert(nt_client_destroy(first) == 0);

    int32_t length = nt_client_step(second, NT_CLIENT_REGISTER, nonce, sizeof(nonce), output, capacity);
    assert(length > 1 && (size_t)length <= capacity);
    assert(output[0] == NT_CLIENT_SEND_FRAME && output[length - 1] == '\n');
    assert(nt_client_step(second, NT_CLIENT_DISCONNECT, NULL, 0, output, capacity) == 0);
    assert(nt_client_destroy(second) == 0);
    free(output);
    return 0;
}
