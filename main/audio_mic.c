/*
 * audio_mic.c — ES8311 codec + I2S microphone capture
 *
 * Uses esp_codec_dev (official Espressif component) for ES8311 control.
 * Follows the same pattern as:
 *   - BSP bsp_audio_codec_microphone_init()
 *   - IDF example peripherals/i2s/i2s_codec/i2s_es8311
 *
 * Hardware (ESP32-P4-Function-EV-Board):
 *   I2S:  MCLK=GPIO13, BCLK=GPIO12, WS=GPIO10, DIN=GPIO11 (codec->ESP)
 *   DOUT=GPIO9 (ESP->codec, not used for mic-only)
 *   I2C:  SDA=GPIO7, SCL=GPIO8 (shared with camera)
 *   PA:   GPIO53 (power amplifier enable)
 *   Codec: ES8311 at 7-bit address 0x18 (8-bit 0x30)
 *
 * Audio: 16-bit, 16000 Hz, mono, PCM -> double-buffered for HTTP serving
 */
#include <string.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "es8311_codec.h"
#include "audio_mic.h"
#include "video_dev.h"

static const char *TAG = "AUDIO_MIC";

/* I2S pins matching BSP esp32_p4_function_ev_board (FIB variant) */
#define I2S_MCLK    GPIO_NUM_13
#define I2S_BCLK    GPIO_NUM_12
#define I2S_WS      GPIO_NUM_10
#define I2S_DIN     GPIO_NUM_11   /* data from codec to ESP32 */

/* Power amplifier enable pin */
#define PA_PIN      GPIO_NUM_53

/* Audio block size: 200ms of 16-bit mono 16kHz PCM */
#define BLK_BYTES   AUDIO_BLOCK_BYTES    /* 6400 */
#define BLK_SAMPLES (BLK_BYTES / 2)

/* ─── VAD (Voice Activity Detection) ───────────────────────────── */
/* Use menuconfig: "Voice Activity Detection" submenu */
#define VAD_RMS_THRESHOLD  CONFIG_VAD_RMS_THRESHOLD
#define VAD_SILENCE_BLOCKS CONFIG_VAD_SILENCE_BLOCKS
#define VOICE_MAX_BLOCKS   CONFIG_VOICE_MAX_BLOCKS

static uint8_t  *s_voice_buf = NULL;      /* accumulated voice PCM (PSRAM) */
static size_t    s_voice_len = 0;
static volatile bool s_voice_ready = false;

typedef enum { VAD_WAITING, VAD_ACTIVE, VAD_TRAILING } vad_state_t;
static vad_state_t s_vad_state = VAD_WAITING;
static int s_silence_count = 0;

/* Double buffer for HTTP serving */
static int16_t  s_audio_buf0[BLK_SAMPLES];
static int16_t  s_audio_buf1[BLK_SAMPLES];
static int      s_active_buf = 0;
static SemaphoreHandle_t s_buf_mux = NULL;
static volatile bool s_audio_ready = false;

static esp_codec_dev_handle_t s_codec_dev = NULL;
static i2s_chan_handle_t s_i2s_rx = NULL;

/* ─── RMS VAD: compute RMS of int16_t PCM block ──────────────────── */
static float calc_rms(const int16_t *samples, int n) {
    float sum = 0;
    for (int i = 0; i < n; i++) {
        sum += (float)samples[i] * (float)samples[i];
    }
    return sqrtf(sum / n);
}

/* --- I2S RX Capture Task ------------------------------------------------- */

static void audio_capture_task(void *arg)
{
    (void)arg;
    int16_t *buf_a = s_audio_buf0;
    int16_t *buf_b = s_audio_buf1;

    ESP_LOGI(TAG, "Capture started (block=%u B / %d ms, VAD=%d)",
             (unsigned)BLK_BYTES, AUDIO_BLOCK_MS, VAD_RMS_THRESHOLD);

    while (1) {
        /* Read one full block via esp_codec_dev */
        size_t total = 0;
        while (total < BLK_BYTES) {
            int ret = esp_codec_dev_read(s_codec_dev,
                      (uint8_t*)buf_a + total,
                      (int)(BLK_BYTES - total));
            if (ret != ESP_CODEC_DEV_OK) {
                ESP_LOGW(TAG, "codec read error %d, retry", ret);
                vTaskDelay(pdMS_TO_TICKS(10));
                continue;
            }
            total = BLK_BYTES;
        }

        /* ── VAD: voice activity detection ─────────────────────────── */
        float rms = calc_rms(buf_a, BLK_SAMPLES);
        bool voice_block = (rms > VAD_RMS_THRESHOLD);

        switch (s_vad_state) {
        case VAD_WAITING:
            if (voice_block) {
                s_vad_state = VAD_ACTIVE;
                s_voice_len = 0;
                s_silence_count = 0;
                /* fall through to ACTIVE */
            } else {
                break;
            }
        case VAD_ACTIVE:
            if (voice_block) {
                s_silence_count = 0;
            } else {
                s_vad_state = VAD_TRAILING;
                s_silence_count = 1;
            }
            break;
        case VAD_TRAILING:
            if (voice_block) {
                s_vad_state = VAD_ACTIVE;
                s_silence_count = 0;
            } else {
                s_silence_count++;
            }
            break;
        }

        /* Accumulate voice blocks */
        if (s_vad_state == VAD_ACTIVE || s_vad_state == VAD_TRAILING) {
            if (s_voice_buf && s_voice_len + BLK_BYTES <= VOICE_MAX_BLOCKS * BLK_BYTES) {
                memcpy(s_voice_buf + s_voice_len, buf_a, BLK_BYTES);
                s_voice_len += BLK_BYTES;
            }
        }

        /* Utterance complete? */
        if (s_vad_state == VAD_TRAILING && s_silence_count >= VAD_SILENCE_BLOCKS) {
            if (s_voice_len >= BLK_BYTES) {
                s_voice_ready = true;
                ESP_LOGI(TAG, "Voice segment: %u B (%.1f s)",
                         (unsigned)s_voice_len,
                         (double)s_voice_len / (AUDIO_SAMPLE_RATE * 2));
            }
            s_vad_state = VAD_WAITING;
            s_silence_count = 0;
        }

        /* Swap double buffer */
        if (s_buf_mux) {
            xSemaphoreTake(s_buf_mux, portMAX_DELAY);
            int16_t *tmp = buf_a;
            buf_a = buf_b;
            buf_b = tmp;
            s_active_buf = (buf_a == s_audio_buf0) ? 0 : 1;
            s_audio_ready = true;
            xSemaphoreGive(s_buf_mux);
        }
    }
}

/* --- Initialization ------------------------------------------------------
 * Follows the official BSP + IDF example flow:
 *   1. Enable PA_PIN GPIO
 *   2. Create simplex I2S RX channel (P4 has independent TX/RX)
 *   3. Wrap I2S as esp_codec_dev data interface
 *   4. Wrap I2C as esp_codec_dev control interface
 *   5. Create ES8311 codec via es8311_codec_new()
 *   6. Create esp_codec_dev handle
 *   7. Open with sample format
 */

esp_err_t audio_mic_init(void)
{
    s_buf_mux = xSemaphoreCreateMutex();
    if (!s_buf_mux) return ESP_ERR_NO_MEM;

    /* 0. Allocate voice segment buffer in PSRAM */
    s_voice_buf = (uint8_t *)heap_caps_malloc(VOICE_MAX_BLOCKS * BLK_BYTES,
                          MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_voice_buf) {
        ESP_LOGE(TAG, "Voice buffer OOM (PSRAM)");
        return ESP_ERR_NO_MEM;
    }
    s_voice_len = 0;
    s_voice_ready = false;

    /* 1. PA_PIN enable -- required for audio codec on P4 EV board */
    gpio_config_t pa_cfg = {
        .pin_bit_mask = BIT64(PA_PIN),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&pa_cfg));
    gpio_set_level(PA_PIN, 1);
    ESP_LOGI(TAG, "PA_PIN (GPIO53) enabled");

    /* 2. Get shared I2C bus from video driver (created by video_dev_init) */
    i2c_master_bus_handle_t i2c_bus = video_get_i2c_bus();
    if (!i2c_bus) {
        ESP_LOGE(TAG, "Video I2C bus not ready — init video first");
        return ESP_ERR_INVALID_STATE;
    }
    ESP_LOGI(TAG, "Using shared I2C bus (from video_dev)");
    esp_err_t ret;

    /* 3. Create I2S RX channel in simplex mode */
    ESP_LOGI(TAG, "Creating I2S RX channel...");
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    ret = i2s_new_channel(&chan_cfg, NULL, &s_i2s_rx);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel RX failed: %s", esp_err_to_name(ret));
        return ret;
    }

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE),
        .slot_cfg = I2S_STD_MSB_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_MCLK,
            .bclk = I2S_BCLK,
            .ws = I2S_WS,
            .dout = GPIO_NUM_NC,       /* TX not used */
            .din = I2S_DIN,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv = false,
            },
        },
    };
    ret = i2s_channel_init_std_mode(s_i2s_rx, &std_cfg);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_init_std_mode failed: %s", esp_err_to_name(ret));
        i2s_del_channel(s_i2s_rx); s_i2s_rx = NULL;
        return ret;
    }
    ret = i2s_channel_enable(s_i2s_rx);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_enable failed: %s", esp_err_to_name(ret));
        i2s_del_channel(s_i2s_rx); s_i2s_rx = NULL;
        return ret;
    }
    ESP_LOGI(TAG, "I2S RX enabled (MCLK=13 BCLK=12 WS=10 DIN=11)");

    /* 4. Wrap I2S as codec data interface */
    audio_codec_i2s_cfg_t i2s_cfg = {
        .port = I2S_NUM_0,
        .rx_handle = (void*)s_i2s_rx,
        .tx_handle = NULL,
        .clk_src = 0,   /* use default clock source */
    };
    const audio_codec_data_if_t *data_if = audio_codec_new_i2s_data(&i2s_cfg);
    if (!data_if) {
        ESP_LOGE(TAG, "audio_codec_new_i2s_data failed");
        i2s_channel_disable(s_i2s_rx); i2s_del_channel(s_i2s_rx); s_i2s_rx = NULL;
        return ESP_FAIL;
    }

    /* 5. Wrap I2C as codec control interface */
    audio_codec_i2c_cfg_t i2c_cfg = {
        .port = I2C_NUM_0,
        .addr = ES8311_CODEC_DEFAULT_ADDR,  /* 0x30 (8-bit write address) */
        .bus_handle = (void*)i2c_bus,
    };
    const audio_codec_ctrl_if_t *ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
    if (!ctrl_if) {
        ESP_LOGE(TAG, "audio_codec_new_i2c_ctrl failed");
        i2s_channel_disable(s_i2s_rx); i2s_del_channel(s_i2s_rx); s_i2s_rx = NULL;
        return ESP_FAIL;
    }

    /* 6. Create ES8311 codec interface
     *    Reference: BSP bsp_audio_codec_microphone_init()
     *    - master_mode = false: ES8311 is I2S slave, ESP32-P4 is master
     *    - use_mclk = true: ESP32-P4 outputs MCLK on GPIO13
     *    - pa_pin = GPIO53: enables power amplifier
     *    - codec_mode = ADC: microphone input only
     */
    es8311_codec_cfg_t es8311_cfg = {
        .ctrl_if = ctrl_if,
        .gpio_if = NULL,               /* use internal GPIO for PA_PIN */
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_ADC,
        .pa_pin = PA_PIN,
        .pa_reverted = false,
        .master_mode = false,
        .use_mclk = true,
        .digital_mic = false,
        .invert_mclk = false,
        .invert_sclk = false,
        .hw_gain = {
            .pa_voltage = 5.0,
            .codec_dac_voltage = 3.3,
            .pa_gain = 0,
        },
        .no_dac_ref = false,
        .mclk_div = 0,  /* 0 = use default (256) */
    };
    const audio_codec_if_t *codec_if = es8311_codec_new(&es8311_cfg);
    if (!codec_if) {
        ESP_LOGE(TAG, "es8311_codec_new failed");
        i2s_channel_disable(s_i2s_rx); i2s_del_channel(s_i2s_rx); s_i2s_rx = NULL;
        return ESP_FAIL;
    }

    /* 7. Create esp_codec_dev device handle */
    esp_codec_dev_cfg_t dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN,
        .codec_if = codec_if,
        .data_if = data_if,
    };
    s_codec_dev = esp_codec_dev_new(&dev_cfg);
    if (!s_codec_dev) {
        ESP_LOGE(TAG, "esp_codec_dev_new failed");
        i2s_channel_disable(s_i2s_rx); i2s_del_channel(s_i2s_rx); s_i2s_rx = NULL;
        return ESP_FAIL;
    }

    /* 8. Configure sample format and start codec */
    esp_codec_dev_sample_info_t fs = {
        .sample_rate = AUDIO_SAMPLE_RATE,
        .channel = AUDIO_CHANNELS,
        .bits_per_sample = AUDIO_BITS,
        .channel_mask = 0,
        .mclk_multiple = 0,  /* 0 = use default (256) */
    };
    int open_ret = esp_codec_dev_open(s_codec_dev, &fs);
    if (open_ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "esp_codec_dev_open failed: %d", open_ret);
        esp_codec_dev_close(s_codec_dev); s_codec_dev = NULL;
        i2s_channel_disable(s_i2s_rx); i2s_del_channel(s_i2s_rx); s_i2s_rx = NULL;
        return ESP_FAIL;
    }

    /* Set mic input gain to a reasonable level (dB) */
    int gain_ret = esp_codec_dev_set_in_gain(s_codec_dev, 30.0f);
    if (gain_ret == ESP_CODEC_DEV_OK) {
        ESP_LOGI(TAG, "Mic gain set to 30.0 dB");
    } else {
        ESP_LOGW(TAG, "Mic gain set returned %d (might be normal)", gain_ret);
    }

    /* 9. Start capture task (stack = 6144 to accommodate ESP_LOG) */
    BaseType_t task_ok = xTaskCreatePinnedToCore(
        audio_capture_task, "audio_capture", 6144,
        NULL, tskIDLE_PRIORITY + 2, NULL, 0);
    if (task_ok != pdPASS) {
        ESP_LOGE(TAG, "Failed to create capture task");
        esp_codec_dev_close(s_codec_dev); s_codec_dev = NULL;
        i2s_channel_disable(s_i2s_rx); i2s_del_channel(s_i2s_rx); s_i2s_rx = NULL;
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "Audio mic initialized: %d Hz, %d-bit, %d ch, block=%d ms",
             AUDIO_SAMPLE_RATE, AUDIO_BITS, AUDIO_CHANNELS, AUDIO_BLOCK_MS);
    return ESP_OK;
}

/* --- Public API ---------------------------------------------------------- */

const int16_t *audio_mic_get_latest_block(size_t *len)
{
    if (!s_audio_ready) {
        if (len) *len = 0;
        return NULL;
    }
    if (s_buf_mux) xSemaphoreTake(s_buf_mux, portMAX_DELAY);
    const int16_t *data = (s_active_buf == 0) ? s_audio_buf0 : s_audio_buf1;
    if (s_buf_mux) xSemaphoreGive(s_buf_mux);
    if (len) *len = BLK_BYTES;
    return data;
}

bool audio_mic_is_ready(void)
{
    return s_audio_ready;
}

esp_err_t audio_mic_deinit(void)
{
    if (s_codec_dev) {
        esp_codec_dev_close(s_codec_dev);
        s_codec_dev = NULL;
    }
    if (s_i2s_rx) {
        i2s_channel_disable(s_i2s_rx);
        i2s_del_channel(s_i2s_rx);
        s_i2s_rx = NULL;
    }
    if (s_voice_buf) { free(s_voice_buf); s_voice_buf = NULL; }
    return ESP_OK;
}

/* ─── Voice segment API ──────────────────────────────────────────── */

const uint8_t *audio_mic_get_voice_segment(size_t *len)
{
    if (!s_voice_ready) { if (len) *len = 0; return NULL; }
    if (len) *len = s_voice_len;
    return s_voice_buf;
}

void audio_mic_clear_voice_segment(void)
{
    s_voice_ready = false;
    s_voice_len = 0;
}
