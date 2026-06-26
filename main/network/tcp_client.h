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

#ifdef __cplusplus
}
#endif

#endif /* TCP_CLIENT_H */
