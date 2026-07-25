#ifndef TCP_CLIENT_H
#define TCP_CLIENT_H

#include "esp_err.h"
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t tcp_client_init(const char *host, uint16_t port);
esp_err_t tcp_client_start(void);
bool      tcp_client_is_connected(void);
void      tcp_client_send(const char *data);
void      tcp_client_send_raw(const char *data, int len);
/* Atomically send header + binary body under mutex (for JPEG/voice frames) */
void      tcp_client_send_binary(const char *hdr, int hlen, const char *body, int blen);
/* Throttled version for large payloads (voice) to avoid stalling esp_hosted */
void      tcp_client_send_binary_throttled(const char *hdr, int hlen, const char *body, int blen);
int       tcp_client_send_nonblock(const char *data, int len);  // 0=skip, 1=sent

#ifdef __cplusplus
}
#endif

#endif /* TCP_CLIENT_H */
