/*
 * ESP32-P4 RTSP camera + Mic gateway
 *
 * Camera: esp_video -> H.264 HW encoder -> RTSP (rtsp://<ip>:8554)
 * Mic:    ES8311 -> I2S -> HTTP WAV  (http://<ip>/mic.wav)
 */
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "network/wifi_manager.h"
#include "network/tcp_client.h"
#include "streamer.h"
#include "audio_mic.h"
#include "video_dev.h"
#include "rtsp_service.h"
#include "uart_stm32.h"
#include "motion.h"

static const char *TAG = "MAIN";
static camera_context s_cam_ctx;

void app_main(void) {
    esp_err_t r = nvs_flash_init();
    if (r == ESP_ERR_NVS_NO_FREE_PAGES || r == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    /* WiFi */
    ESP_ERROR_CHECK(wifi_manager_init());
    ESP_ERROR_CHECK(wifi_manager_start(CONFIG_ESP_WIFI_SSID, CONFIG_ESP_WIFI_PASSWORD));
    int w = 0;
    while (!wifi_manager_is_connected() && w < 150) { vTaskDelay(pdMS_TO_TICKS(100)); w++; }
    if (wifi_manager_is_connected()) ESP_LOGI(TAG, "WiFi connected");
    else ESP_LOGW(TAG, "WiFi timeout");

    /* TCP client (navigation) */
    tcp_client_init(CONFIG_PC_SERVER_IP, CONFIG_PC_SERVER_PORT);
    tcp_client_start();

    /* HTTP server (for audio /mic.wav) */
    start_streaming_server();

    /* Video first — creates shared I2C bus used by audio too */
    ESP_LOGI(TAG, "Init video device...");
    if (video_dev_init(&s_cam_ctx) == 0) {
        ESP_LOGI(TAG, "Starting RTSP server...");
        rtsp_service_start(&s_cam_ctx);
    } else {
        ESP_LOGE(TAG, "Video init failed");
    }

    /* Audio mic — uses I2C bus from video_dev */
    r = audio_mic_init();
    if (r != ESP_OK) ESP_LOGW(TAG, "Mic init failed (non-fatal)");
    else ESP_LOGI(TAG, "Mic ready -> http://<ip>/mic.wav");

    /* UART STM32 (motor controller via GPIO5/6) */
    r = uart_stm32_init(NULL);
    if (r != ESP_OK) ESP_LOGE(TAG, "STM32 UART init failed");
    else ESP_LOGI(TAG, "STM32 UART ready");

    /* Motion controller */
    r = motion_init();
    if (r != ESP_OK) ESP_LOGE(TAG, "Motion init failed");
    else ESP_LOGI(TAG, "Motion controller ready");

    while (1) { vTaskDelay(1000); }
}
