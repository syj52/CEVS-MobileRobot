/*
 * uart_stm32.c — UART to STM32 motor controller
 *
 * Hardware:  ESP32 GPIO5(TX) → STM32 PA10(RX)
 *            ESP32 GPIO6(RX) ← STM32 PA9(TX)
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
#define UART_BAUD       4800
#define UART_TX_PIN     GPIO_NUM_5
#define UART_RX_PIN     GPIO_NUM_6
#define UART_RX_BUF_SZ  256

/* Line buffer for RX */
#define LINE_BUF_SZ     64
static char s_line_buf[LINE_BUF_SZ];
static int  s_line_len = 0;
static void (*s_rx_cb)(const char *) = NULL;

static bool s_initialized = false;

/* UART driver event queue (from uart_driver_install) */
static QueueHandle_t s_uart_queue = NULL;
/* App-level send queue (thread-safe frame delivery) */
static QueueHandle_t s_send_queue = NULL;

static void uart_event_task(void *arg)
{
    (void)arg;
    uart_event_t evt;
    uint8_t data[64];

    while (1) {
        if (s_uart_queue && xQueueReceive(s_uart_queue, &evt, pdMS_TO_TICKS(50)) == pdTRUE) {
            if (evt.type == UART_DATA) {
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
                        if (s_rx_cb) s_rx_cb(s_line_buf);
                        s_line_len = 0;
                    } else if (s_line_len < LINE_BUF_SZ - 1) {
                        s_line_buf[s_line_len++] = c;
                    }
                }
            }
        }

        if (s_send_queue) {
            char *frame = NULL;
            while (xQueueReceive(s_send_queue, &frame, 0) == pdTRUE) {
                if (frame) {
                    uart_write_bytes(UART_PORT, frame, strlen(frame));
                    uart_wait_tx_done(UART_PORT, pdMS_TO_TICKS(100));
                    ESP_LOGI(TAG, "TX: %s", frame);
                    free(frame);
                }
            }
        }
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
    /* App-level send queue */
    s_send_queue = xQueueCreate(8, sizeof(char *));
    if (!s_send_queue) return ESP_ERR_NO_MEM;

    xTaskCreatePinnedToCore(uart_event_task, "uart_stm32", 3072,
                            NULL, tskIDLE_PRIORITY + 2, NULL, 0);

    s_initialized = true;
    ESP_LOGI(TAG, "UART1 ready: TX=GPIO5 RX=GPIO6 @ 4800 baud");
    return ESP_OK;
}

esp_err_t uart_stm32_send(const char *frame)
{
    if (!s_initialized || !frame) return ESP_ERR_INVALID_STATE;
    printf("[UART_TX] %s\n", frame);
    char *copy = strdup(frame);
    if (!copy) return ESP_ERR_NO_MEM;
    if (s_send_queue && xQueueSend(s_send_queue, &copy, pdMS_TO_TICKS(100)) != pdTRUE) {
        free(copy);
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}

bool uart_stm32_is_ready(void) { return s_initialized; }
