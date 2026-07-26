/*
 * audio_spk.c — MAX98357 I2S speaker playback (independent I2S_NUM_1)
 *
 * MAX98357 connects to J1 header:
 *   BCLK → J1-13 (GPIO20)
 *   LRC  → J1-11 (GPIO21)
 *   DIN  → J1-12 (GPIO22)
 *   VIN  → J1-2/4 (5V)
 *   GND  → J1-6
 *
 * Audio: 16-bit, 16000 Hz, mono PCM (same format as TTS output).
 * I2S_NUM_1 is independent from the mic's I2S_NUM_0.
 */

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/ringbuf.h"
#include "esp_log.h"
#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "audio_spk.h"

static const char *TAG = "AUDIO_SPK";

/* I2S pins for MAX98357 on J1 header */
#define SPK_I2S_NUM     I2S_NUM_1
#define SPK_BCLK        GPIO_NUM_20
#define SPK_WS          GPIO_NUM_21
#define SPK_DOUT        GPIO_NUM_22

/* Playback ring buffer: up to ~4 seconds at 16kHz/16bit */
#define SPK_RING_BUF_SIZE    (16000 * 2 * 4)   /* 128 KB */

static RingbufHandle_t s_play_buf = NULL;
static bool s_playing = false;
static TaskHandle_t s_play_task = NULL;
static i2s_chan_handle_t s_i2s_tx = NULL;

/* ─── Playback task ─────────────────────────────────────────── */
static void play_task(void *arg)
{
    (void)arg;
    size_t item_size;
    while (1) {
        uint8_t *data = (uint8_t *)xRingbufferReceive(s_play_buf, &item_size, pdMS_TO_TICKS(100));
        if (!data || item_size == 0) {
            if (s_playing) s_playing = false;
            continue;
        }
        s_playing = true;

        if (!s_i2s_tx) {
            vRingbufferReturnItem(s_play_buf, data);
            continue;
        }

        /* Write PCM data to I2S TX in chunks */
        size_t written = 0;
        while (written < item_size) {
            size_t chunk = (item_size - written > 4096) ? 4096 : (item_size - written);
            int ret = i2s_channel_write(s_i2s_tx, data + written, (int)chunk, NULL, portMAX_DELAY);
            if (ret != ESP_OK) {
                ESP_LOGW(TAG, "i2s write error %d", ret);
                break;
            }
            written += chunk;
        }

        vRingbufferReturnItem(s_play_buf, data);
    }
}

/* ─── Public API ────────────────────────────────────────────── */

esp_err_t audio_spk_init(void)
{
    if (s_play_buf) {
        ESP_LOGW(TAG, "Already initialized");
        return ESP_OK;
    }

    /* 1. Create ring buffer in PSRAM */
    s_play_buf = xRingbufferCreate(SPK_RING_BUF_SIZE, RINGBUF_TYPE_BYTEBUF);
    if (!s_play_buf) {
        ESP_LOGE(TAG, "Ring buffer creation failed");
        return ESP_ERR_NO_MEM;
    }

    /* 2. Create I2S TX channel on I2S_NUM_1 (independent from mic) */
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(SPK_I2S_NUM, I2S_ROLE_MASTER);
    esp_err_t ret = i2s_new_channel(&chan_cfg, &s_i2s_tx, NULL);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel TX failed: %s", esp_err_to_name(ret));
        vRingbufferDelete(s_play_buf); s_play_buf = NULL;
        return ret;
    }

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
        .slot_cfg = I2S_STD_MSB_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = GPIO_NUM_NC,        /* MAX98357 doesn't need MCLK */
            .bclk = SPK_BCLK,
            .ws = SPK_WS,
            .dout = SPK_DOUT,
            .din = GPIO_NUM_NC,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv = false,
            },
        },
    };
    ret = i2s_channel_init_std_mode(s_i2s_tx, &std_cfg);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "i2s init failed: %s", esp_err_to_name(ret));
        i2s_del_channel(s_i2s_tx); s_i2s_tx = NULL;
        vRingbufferDelete(s_play_buf); s_play_buf = NULL;
        return ret;
    }
    ret = i2s_channel_enable(s_i2s_tx);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "i2s enable failed: %s", esp_err_to_name(ret));
        i2s_del_channel(s_i2s_tx); s_i2s_tx = NULL;
        vRingbufferDelete(s_play_buf); s_play_buf = NULL;
        return ret;
    }

    /* 3. Create playback task */
    BaseType_t rt = xTaskCreatePinnedToCore(
        play_task, "spk_play", 3072, NULL,
        tskIDLE_PRIORITY + 1, &s_play_task, 1);
    if (rt != pdPASS) {
        ESP_LOGE(TAG, "Failed to create play task");
        i2s_channel_disable(s_i2s_tx); i2s_del_channel(s_i2s_tx); s_i2s_tx = NULL;
        vRingbufferDelete(s_play_buf); s_play_buf = NULL;
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "Speaker ready: I2S_NUM_1 BCLK=GPIO20 WS=GPIO21 DOUT=GPIO22");
    return ESP_OK;
}

esp_err_t audio_spk_deinit(void)
{
    if (s_play_task) { vTaskDelete(s_play_task); s_play_task = NULL; }
    if (s_i2s_tx) { i2s_channel_disable(s_i2s_tx); i2s_del_channel(s_i2s_tx); s_i2s_tx = NULL; }
    if (s_play_buf) { vRingbufferDelete(s_play_buf); s_play_buf = NULL; }
    s_playing = false;
    return ESP_OK;
}

esp_err_t audio_spk_play(const uint8_t *pcm, size_t len)
{
    if (!s_play_buf || !pcm || len == 0) return ESP_ERR_INVALID_STATE;
    BaseType_t ret = xRingbufferSend(s_play_buf, pcm, len, pdMS_TO_TICKS(500));
    if (ret != pdTRUE) {
        ESP_LOGW(TAG, "Ring buffer full, dropping %u B", (unsigned)len);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

bool audio_spk_is_playing(void) { return s_playing; }

void audio_spk_stop(void)
{
    s_playing = false;
}
