#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include "esp_err.h"
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Initialize netif / event loop / extconn / esp_wifi and register event handler. */
esp_err_t wifi_manager_init(void);

/* Configure SSID/password and start WiFi connection (non-blocking). */
esp_err_t wifi_manager_start(const char *ssid, const char *password);

/* Query whether an IP has been obtained. */
bool wifi_manager_is_connected(void);

#ifdef __cplusplus
}
#endif

#endif /* WIFI_MANAGER_H */
