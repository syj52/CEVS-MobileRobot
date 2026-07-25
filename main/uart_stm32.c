/*
 * uart_stm32.c — UART to STM32 motor controller
 *
 * Hardware:  ESP32 GPIO5(TX) → STM32 PA10(RX)
 *            ESP32 GPIO26(RX) ← STM32 PA9(TX)
 *            Baud: 4800, 8N1
 *
 * Protocol: $<dir>,0,0,<spin>,0,0,<speed>,0,0,0#
 *   dir=1F/2B/3L/4R/0Stop  spin=1Left/2Right  speed=0-9(×100)
 *   RX: EXEC:<cmd>\r\n
 *
 * Queue-based async driver.  Task stack in internal RAM (not PSRAM).
 */
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/uart.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "uart_stm32.h"

static const char *TAG = "UART_STM32";

#define UART_PORT       UART_NUM_1
#define UART_BAUD       115200
#define UART_TX_PIN     GPIO_NUM_5
#define UART_RX_PIN     GPIO_NUM_4
/* RX ring buffer from uart_driver_install — must be large enough to
 * hold all STM32 telemetry between event task wakes.
 * STM32 sends ~500 bytes/s ($IMU + $ODOM + $SNSR + EXEC), so 8192
 * gives ~16 seconds of headroom. */
#define UART_RX_BUF_SZ  8192

/* Line buffer for RX — reset after LINE_TIMEOUT_MS if no \n seen */
#define LINE_BUF_SZ     128
#define LINE_TIMEOUT_MS 500
static char s_line_buf[LINE_BUF_SZ];
static int  s_line_len = 0;
static TickType_t s_line_start_tick = 0;   /* tick when current line began */
static void (*s_rx_cb)(const char *) = NULL;

static bool s_initialized = false;
static TickType_t s_last_rx_tick = 0;

/* Latest $ODOM encoder values (updated on every complete $ODOM frame) */
static volatile stm32_odom_t s_latest_odom = {{0}};

/* Latest IMU heading (yaw angle in degrees from $IMU EULER field) */
static volatile float s_latest_yaw = 0.0f;

/* UART driver event queue (from uart_driver_install) */
static QueueHandle_t s_uart_queue = NULL;
/* App-level send queue (thread-safe frame delivery) */
static QueueHandle_t s_send_queue = NULL;

/* ─── TX task — sends queued frames; runs independently so RX is never blocked ─── */

static void uart_tx_task(void *arg)
{
    (void)arg;
    while (1) {
        char *frame = NULL;
        if (s_send_queue && xQueueReceive(s_send_queue, &frame, portMAX_DELAY) == pdTRUE) {
            if (frame) {
                uart_write_bytes(UART_PORT, frame, strlen(frame));
                free(frame);
            }
        }
    }
}

/* ─── RX task — processes incoming UART data ─── */

static void uart_rx_task(void *arg)
{
    (void)arg;
    uart_event_t evt;
    uint8_t data[64];

    while (1) {
        if (s_uart_queue && xQueueReceive(s_uart_queue, &evt, pdMS_TO_TICKS(50)) == pdTRUE) {
            if (evt.type == UART_DATA) {
                s_last_rx_tick = xTaskGetTickCount();
                int len = uart_read_bytes(UART_PORT, data, sizeof(data) - 1, 0);
                if (len <= 0) continue;
                data[len] = 0;
                for (int i = 0; i < len; i++) {
                    char c = (char)data[i];
                    if (c == '\n') {
                        if (s_line_len > 0 && s_line_buf[s_line_len - 1] == '\r')
                            s_line_buf[s_line_len - 1] = '\0';
                        else
                            s_line_buf[s_line_len] = '\0';
                        ESP_LOGD(TAG, "RX: %s", s_line_buf);
                        // printf("[STM32_RX] %s\n", s_line_buf);  // commented: saves ~5ms per frame

                        /* Parse $ODOM encoder values */
                        if (s_line_buf[0] == '$' && memcmp(s_line_buf, "$ODOM", 5) == 0) {
                            const char *p = strstr(s_line_buf, "ENC=");
                            if (p) {
                                p += 4;
                                s_latest_odom.enc[0] = atol(p);
                                p = strchr(p, ','); if (p) { s_latest_odom.enc[1] = atol(p + 1); p = strchr(p + 1, ','); }
                                if (p) { s_latest_odom.enc[2] = atol(p + 1); p = strchr(p + 1, ','); }
                                if (p) { s_latest_odom.enc[3] = atol(p + 1); }
                            }

                        }

                        /* Parse $IMU: EULER,roll,pitch,yaw,GYRO,gx,gy,gz,ACCEL,ax,ay,az */
                        if (s_line_buf[0] == '$' && memcmp(s_line_buf, "$IMU", 4) == 0) {
                            /* Format: $IMU,EULER,roll,pitch,yaw,GYRO,... */
                            const char *p = strstr(s_line_buf, "EULER,");
                            if (p) {
                                p += 6;                  /* skip "EULER," */
                                p = strchr(p, ','); if (p) p++;  /* skip roll */
                                p = strchr(p, ','); if (p) p++;  /* skip pitch */
                                if (p) s_latest_yaw = atof(p);   /* yaw */
                            }
                        }

                        if (s_rx_cb) s_rx_cb(s_line_buf);
                        s_line_len = 0;
                        s_line_start_tick = 0;
                    } else if (s_line_len < LINE_BUF_SZ - 1) {
                        if (s_line_start_tick == 0) s_line_start_tick = xTaskGetTickCount();
                        s_line_buf[s_line_len++] = c;
                    }
                }
            } else if (evt.type == UART_FIFO_OVF || evt.type == UART_FRAME_ERR || evt.type == UART_PARITY_ERR || evt.type == UART_BREAK) {
                /* RX error — flush to recover the UART peripheral */
                ESP_LOGW(TAG, "UART RX error (type=%d), flushing", evt.type);
                uart_flush_input(UART_PORT);
                s_line_len = 0;
                s_line_start_tick = 0;
                s_last_rx_tick = xTaskGetTickCount();
            }
        }

        /* Line buffer timeout: if a frame was truncated by RX overflow and no
         * \n has arrived for LINE_TIMEOUT_MS, reset the buffer so the parser
         * can recover on the next complete frame instead of accumulating junk. */
        if (s_line_len > 0 && s_line_start_tick != 0
            && (xTaskGetTickCount() - s_line_start_tick) > pdMS_TO_TICKS(LINE_TIMEOUT_MS)) {
            ESP_LOGW(TAG, "RX line timeout — resetting buffer (len=%d)", s_line_len);
            s_line_len = 0;
            s_line_start_tick = 0;
        }

        /* Warn if no STM32 data for 3+ seconds */
        if (s_initialized && (xTaskGetTickCount() - (s_last_rx_tick ? s_last_rx_tick : 0)) > pdMS_TO_TICKS(3000)) {
            s_last_rx_tick = xTaskGetTickCount();
            ESP_LOGW(TAG, "No STM32 data for 3s — check wiring/baud/power (UART1 GPIO5/26 @ 115200)");
        }

        /* Also drain after RX processing, so telemetry bursts don't starve TX */
    }
}

esp_err_t uart_stm32_init(void (*rx_callback)(const char *))
{
    s_rx_cb = rx_callback;

    uart_config_t cfg = {
        .baud_rate  = UART_BAUD,
        .data_bits  = UART_DATA_8_BITS,
        .parity     = UART_PARITY_DISABLE,
        .stop_bits  = UART_STOP_BITS_1,
        .flow_ctrl  = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    /* 1. Install driver first (creates event queue) */
    ESP_ERROR_CHECK(uart_driver_install(UART_PORT, UART_RX_BUF_SZ, 0,
                                        20, &s_uart_queue, 0));
    /* 2. Configure parameters */
    ESP_ERROR_CHECK(uart_param_config(UART_PORT, &cfg));
    /* 3. Set pins via GPIO matrix */
    ESP_ERROR_CHECK(uart_set_pin(UART_PORT, UART_TX_PIN, UART_RX_PIN,
                                 UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    /* Enable internal pull-up on RX pin so it doesn't float when STM32 is
     * disconnected — without this, noise on a floating RX pin generates
     * spurious [STM32_RX] output and can disrupt protocol parsing. */
    ESP_ERROR_CHECK(gpio_set_pull_mode(UART_RX_PIN, GPIO_PULLUP_ONLY));
    /* App-level send queue — 16 entries handles bursts from motion_task + keyboard */
    s_send_queue = xQueueCreate(16, sizeof(char *));
    if (!s_send_queue) return ESP_ERR_NO_MEM;

    /* RX task: higher priority — never blocked by TX */
    xTaskCreatePinnedToCore(uart_rx_task, "uart_rx", 3072,
                            NULL, tskIDLE_PRIORITY + 3, NULL, 0);
    /* TX task: lower priority — independent, won't stall RX */
    xTaskCreatePinnedToCore(uart_tx_task, "uart_tx", 2048,
                            NULL, tskIDLE_PRIORITY + 1, NULL, 0);

    s_initialized = true;
    ESP_LOGI(TAG, "UART1 ready: TX=GPIO%d RX=GPIO%d @ %d baud",
             UART_TX_PIN, UART_RX_PIN, UART_BAUD);
    return ESP_OK;
}

esp_err_t uart_stm32_send(const char *frame)
{
    if (!s_initialized || !frame) return ESP_ERR_INVALID_STATE;
    char *copy = strdup(frame);
    if (!copy) return ESP_ERR_NO_MEM;
    if (s_send_queue && xQueueSend(s_send_queue, &copy, pdMS_TO_TICKS(100)) != pdTRUE) {
        free(copy);
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}

bool uart_stm32_is_ready(void) { return s_initialized; }

void uart_stm32_get_odom(stm32_odom_t *out)
{
    if (out) {
        out->enc[0] = s_latest_odom.enc[0];
        out->enc[1] = s_latest_odom.enc[1];
        out->enc[2] = s_latest_odom.enc[2];
        out->enc[3] = s_latest_odom.enc[3];
    }
}

float uart_stm32_get_yaw(void)
{
    return s_latest_yaw;  /* IMU module already does internal fusion, no EMA needed */
}
