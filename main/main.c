/*
 * ESP32-P4 Car + Camera Gateway
 * WiFi STA → TCP client to PC → Camera capture → HTTP server
 */
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "network/wifi_manager.h"
#include "network/tcp_client.h"
#include "camera_driver.h"
#include "streamer.h"

static const char *TAG = "MAIN";

void app_main(void) {
    esp_err_t r = nvs_flash_init();
    if (r == ESP_ERR_NVS_NO_FREE_PAGES || r == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase()); ESP_ERROR_CHECK(nvs_flash_init());
    }

    /* WiFi */
    ESP_ERROR_CHECK(wifi_manager_init());
    ESP_ERROR_CHECK(wifi_manager_start(CONFIG_ESP_WIFI_SSID, CONFIG_ESP_WIFI_PASSWORD));

    int w = 0;
    while (!wifi_manager_is_connected() && w < 150) { vTaskDelay(pdMS_TO_TICKS(100)); w++; }
    if (wifi_manager_is_connected()) ESP_LOGI(TAG, "WiFi connected");
    else ESP_LOGW(TAG, "WiFi timeout — continuing");

    /* TCP client (to PC center server) */
    tcp_client_init(CONFIG_PC_SERVER_IP, CONFIG_PC_SERVER_PORT);
    tcp_client_start();
    ESP_LOGI(TAG, "TCP client→%s:%d", CONFIG_PC_SERVER_IP, CONFIG_PC_SERVER_PORT);

    /* Camera */
    r = camera_init();
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "Camera init failed: %s", esp_err_to_name(r));
    } else {
        ESP_LOGI(TAG, "Camera streaming: 1280x720 RGB565 30fps");
    }

    /* HTTP server (serves /raw for camera frames) */
    start_streaming_server();

    /* Idle */
    while (1) { vTaskDelay(1000); }
}
