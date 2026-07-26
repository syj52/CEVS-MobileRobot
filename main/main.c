/*
 * ESP32-P4: MJPEG camera + Mic + TCP video stream
 *
 * Camera: esp_video → HW JPEG encoder → TCP to server → WebSocket → frontend
 * Mic:    ES8311 → I2S → HTTP WAV (http://<ip>/mic.wav)
 */
#include <stdio.h>
#include <string.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "nvs_flash.h"
#include "network/wifi_manager.h"
#include "network/tcp_client.h"
#include "streamer.h"
#include "audio_mic.h"
#include "audio_spk.h"
#include "video_dev.h"
#include "uart_stm32.h"
#include "motion.h"
#include "display_driver.h"
#include "qrcodegen.h"
#include "qrcodegen.h"
#include "nav/nav_grid.h"
static const char *TAG = "MAIN";
static camera_context s_cam_ctx;
/* ── Frame queue: decouples JPEG encoding from TCP send ────── */
#define FRAME_QUEUE_LEN  2
static QueueHandle_t s_frame_q = NULL;
typedef struct {
    uint8_t *data;
    size_t   len;
} jpeg_frame_t;
/* ── Diagnostics: shared counters ──────────────────────────── */
static volatile int s_enc_frames = 0;   /* frames encoded */
static volatile int s_snd_frames = 0;   /* frames sent via TCP */
static volatile int s_enc_iters  = 0;   /* encoder_task loop count */
static volatile int s_snd_iters  = 0;   /* sender_task loop count */
static volatile bool s_in_voice_send = false;
static volatile bool s_in_jpeg_send  = false;
static void encoder_task(void *arg) {
    (void)arg;
    while (1) {
        s_enc_iters++;
        frame_buffer_t *fb = video_fb_get(&s_cam_ctx);
        if (!fb || !fb->buf || fb->len == 0) {
            vTaskDelay(pdMS_TO_TICKS(5));
            continue;
        }
        /* Copy JPEG frame to a heap buffer and queue it for sending */
        uint8_t *copy = heap_caps_malloc(fb->len, MALLOC_CAP_SPIRAM);
        if (copy) {
            memcpy(copy, fb->buf, fb->len);
            jpeg_frame_t item = { .data = copy, .len = fb->len };
            if (xQueueSend(s_frame_q, &item, 0) != pdTRUE) {
                free(copy);  /* queue full → drop */
            } else {
                s_enc_frames++;
            }
        }
        video_after_take(&s_cam_ctx);
    }
}
static void sender_task(void *arg) {
    (void)arg;
    /* Frame-rate cap: don't send faster than ~12fps. This bounds the video
     * bitrate so it fits within the esp_hosted SDIO/WiFi link's reliable
     * throughput, leaving headroom for voice bursts and preventing the link
     * from saturating (which caused the send() to chronically block). */
    const TickType_t MIN_SEND_INTERVAL = pdMS_TO_TICKS(200);  /* 5 fps — smooth streaming */
    TickType_t last_send = 0;
    while (1) {
        s_snd_iters++;
        jpeg_frame_t item;
        if (xQueueReceive(s_frame_q, &item, portMAX_DELAY) != pdTRUE) continue;
        TickType_t now = xTaskGetTickCount();
        if (now - last_send < MIN_SEND_INTERVAL) {
            free(item.data);   /* too soon — drop this frame to cap the rate */
            continue;
        }
        if (tcp_client_is_connected()) {
            char header[32];
            int hlen = snprintf(header, sizeof(header), "$JPEG:%u\r\n", (unsigned)item.len);
            s_in_jpeg_send = true;
            tcp_client_send_binary_throttled(header, hlen, (const char *)item.data, (int)item.len);  /* 8KB chunks, 10ms yield → STOP window */
            s_in_jpeg_send = false;
            s_snd_frames++;
            last_send = now;
        }
        free(item.data);
    }
}
static void on_stm32_rx(const char *line) {
    /* 转发 STM32 遥测数据到 TCP 服务器（odom/imu/pose 用于定位+标定） */
    if (tcp_client_is_connected() && line && line[0] == '$') {
        tcp_client_send(line);
    }
}
void app_main(void) {
    /* Suppress driver-level INFO logs that waste CPU on UART */
    esp_log_level_set("*", ESP_LOG_ERROR);
    esp_log_level_set("MAIN", ESP_LOG_INFO);
    esp_log_level_set("MOTION", ESP_LOG_INFO);
    esp_log_level_set("tcp_client", ESP_LOG_INFO);   /* nav command dispatch */
    esp_log_level_set("DISP", ESP_LOG_INFO);
    esp_err_t r = nvs_flash_init();
    if (r == ESP_ERR_NVS_NO_FREE_PAGES || r == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }
    ESP_ERROR_CHECK(wifi_manager_init());
    ESP_ERROR_CHECK(wifi_manager_start(CONFIG_ESP_WIFI_SSID, CONFIG_ESP_WIFI_PASSWORD));
    int w = 0;
    while (!wifi_manager_is_connected() && w < 150) { vTaskDelay(pdMS_TO_TICKS(100)); w++; }
    if (wifi_manager_is_connected()) ESP_LOGI(TAG, "WiFi connected");
    else ESP_LOGW(TAG, "WiFi timeout");
    /* MIPI DSI Display — init AFTER WiFi to avoid SDIO conflict */
    r = display_init();
    /* Build QR URL from server IP for nav page */
    char qr_url[128];
    snprintf(qr_url, sizeof(qr_url), "http://%s:8000/nav",
             tcp_client_get_server_host() ? tcp_client_get_server_host() : "192.168.1.1");
    ESP_LOGI(TAG, "QR URL: %s", qr_url);
    if (r != ESP_OK) ESP_LOGE(TAG, "Display init failed");
    else ESP_LOGI(TAG, "Display ready");
    /* TCP client (command/control + video frames) */
    tcp_client_init(CONFIG_PC_SERVER_IP, CONFIG_PC_SERVER_PORT);
    tcp_client_start();
    /* HTTP server (static content + audio) */
    start_streaming_server();
    /* Video: HW JPEG encoder pipeline */
    ESP_LOGI(TAG, "Init video (JPEG)...");
    if (video_dev_init(&s_cam_ctx) == 0) {
        if (video_start(1280, 720, &s_cam_ctx) == ESP_OK) {
            /* Frame queue decouples encoding from sending */
            s_frame_q = xQueueCreate(FRAME_QUEUE_LEN, sizeof(jpeg_frame_t));
            if (s_frame_q) {
                xTaskCreatePinnedToCore(encoder_task, "jpeg_enc", 3072, NULL,
                    tskIDLE_PRIORITY + 2, NULL, 0);  /* CPU 0: encode */
                xTaskCreatePinnedToCore(sender_task, "jpeg_snd", 3072, NULL,
                    tskIDLE_PRIORITY + 1, NULL, 1);  /* CPU 1: TCP send */
            }
        }
    } else {
        ESP_LOGE(TAG, "Video init failed");
    }
    /* Audio */
    r = audio_mic_init();
    if (r != ESP_OK) ESP_LOGW(TAG, "Mic init failed (non-fatal)");
    else ESP_LOGI(TAG, "Mic ready → http://<ip>/mic.wav");
    /* Speaker (MAX98357 via I2S DOUT=GPIO9) */
    r = audio_spk_init();
    if (r != ESP_OK) ESP_LOGW(TAG, "Speaker init failed (non-fatal)");
    else ESP_LOGI(TAG, "Speaker ready");
    /* UART STM32 */
    r = uart_stm32_init(on_stm32_rx);
    if (r != ESP_OK) ESP_LOGE(TAG, "STM32 UART init failed");
    else ESP_LOGI(TAG, "STM32 UART ready");
    /* Motion */
    r = motion_init();
    if (r != ESP_OK) ESP_LOGE(TAG, "Motion init failed");
    else ESP_LOGI(TAG, "Motion controller ready");
    /* Voice & health: check voice segments AND send periodic PING to
     * detect half-broken TCP connections (where send succeeds locally on
     * lwIP buffered data but never reaches the server).  The server responds
     * with "OK:PING\r\n" — if we never get it, our connection is dead. */
    TickType_t last_voice_send = 0;
    const TickType_t VOICE_COOLDOWN = pdMS_TO_TICKS(4000);
    TickType_t last_ping = 0;
    const TickType_t PING_INTERVAL = pdMS_TO_TICKS(5000);
    /* HB counters from previous cycle */
    int last_enc_f = 0, last_snd_f = 0, last_enc_i = 0, last_snd_i = 0;
    TickType_t last_hb = 0;
    bool map_rendered = false;
    float last_x = 0, last_y = 0, last_a = 0;
    while (1) {
        /* ── Map render (once, when data arrives) ───────────── */
        if (!map_rendered && display_is_ready() && g_grid_map.valid) {
            display_set_map_meta(g_grid_map.res, g_grid_map.ox, g_grid_map.oy);
            display_render_map(g_grid_map.width, g_grid_map.height, g_grid_map.data);
            const robot_pose_t *p = motion_get_pose();
            if (p && p->valid) display_render_pose(p->x_m, p->y_m, p->angle_deg);
            display_render_qr(qr_url, 6, 2);
            display_flush_fb();
            map_rendered = true;
            ESP_LOGI(TAG, "Map + pose rendered to display");
        }
        /* ── Pose refresh ────────────────────────────────── */
        {
            static bool last_valid = false;
            static bool last_had_target = false;
            static float last_tx = 0, last_ty = 0;
            const robot_pose_t *p = motion_get_pose();
            bool now_valid = p && p->valid;
            if (map_rendered && display_is_ready() && now_valid) {
                float tx, ty;
                bool has_target = motion_get_target(&tx, &ty);
                bool target_changed = (has_target != last_had_target)
                    || (has_target && (fabsf(tx - last_tx) > 0.01f || fabsf(ty - last_ty) > 0.01f));
                bool pos_changed = !last_valid
                    || fabsf(p->x_m - last_x) > 0.01f
                    || fabsf(p->y_m - last_y) > 0.01f
                    || fabsf(p->angle_deg - last_a) > 1.0f;
                if (pos_changed || target_changed) {
                    static int64_t last_flush_us = 0;
                    int64_t now_us = esp_timer_get_time();
                    if (now_us - last_flush_us > 50000) {  /* max ~20 fps */
                        display_render_map(g_grid_map.width, g_grid_map.height, g_grid_map.data);
                        display_render_pose(p->x_m, p->y_m, p->angle_deg);
                        if (has_target)
                            display_render_target(tx, ty);
            display_render_qr(qr_url, 6, 2);
            display_flush_fb();
                        last_flush_us = now_us;
                    }
                    last_x = p->x_m; last_y = p->y_m; last_a = p->angle_deg;
                    last_had_target = has_target;
                    if (has_target) { last_tx = tx; last_ty = ty; }
                }
            }
            last_valid = now_valid;
        }
        /* Motion timeout: auto-stop if no raw $ cmd received in 500ms */
        motion_tick();
        size_t voice_len = 0;
        const uint8_t *voice = audio_mic_get_voice_segment(&voice_len);
        if (voice && voice_len > 0) {
            TickType_t vnow = xTaskGetTickCount();
            bool cooled = (last_voice_send == 0) || (vnow - last_voice_send >= VOICE_COOLDOWN);
            if (cooled && tcp_client_is_connected()) {
                int64_t t0 = esp_timer_get_time();
                char header[32];
                int hlen = snprintf(header, sizeof(header), "$VOICE:%u\r\n", (unsigned)voice_len);
                s_in_voice_send = true;
                tcp_client_send_binary_throttled(header, hlen, (const char *)voice, (int)voice_len);
                s_in_voice_send = false;
                int64_t send_ms = (esp_timer_get_time() - t0) / 1000;
                ESP_LOGW(TAG, "[VOICE] sent %u B in %lld ms", (unsigned)voice_len, send_ms);
                last_voice_send = vnow;
            } else if (!cooled) {
                ESP_LOGW(TAG, "[VOICE] dropped (cooldown)");
            }
            audio_mic_clear_voice_segment();
        }
        /* ── TCP health check: PING every 5s ────────────────── */
        TickType_t now2 = xTaskGetTickCount();
        if (now2 - last_ping >= PING_INTERVAL) {
            tcp_client_send("CMD:PING\r\n");
            last_ping = now2;
        }
        /* Heartbeat (silent — only update counters) */
        if (now2 - last_hb >= pdMS_TO_TICKS(2000)) {
            int ef = s_enc_frames - last_enc_f, sf = s_snd_frames - last_snd_f;
            int ei = s_enc_iters - last_enc_i, si = s_snd_iters - last_snd_i;
            last_hb = now2;
            last_enc_f = s_enc_frames; last_snd_f = s_snd_frames;
            last_enc_i = s_enc_iters;  last_snd_i = s_snd_iters;
            (void)ef; (void)sf; (void)ei; (void)si;
        }
        vTaskDelay(pdMS_TO_TICKS(50));  /* 20 Hz loop */
    }
}
