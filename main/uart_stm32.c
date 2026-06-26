/*
 * uart_stm32.c — UART1 to STM32 car controller (GPIO5 TX, GPIO6 RX)
 * Protocol: same as Bluetooth App frames: $1,0,0,0,0,0,0,0,0,0#
 */
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/uart.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "uart_stm32.h"

static const char *TAG = "STM32_UART";

#define CAR_UART_PORT       UART_NUM_1
#define CAR_UART_BAUD_RATE  4800
#define CAR_UART_TX_GPIO    GPIO_NUM_5
#define CAR_UART_RX_GPIO    GPIO_NUM_6
#define CAR_UART_RX_BUF     256

esp_err_t uart_stm32_init(void)
{
    uart_config_t uart_config = {
        .baud_rate  = CAR_UART_BAUD_RATE,
        .data_bits  = UART_DATA_8_BITS,
        .parity     = UART_PARITY_DISABLE,
        .stop_bits  = UART_STOP_BITS_1,
        .flow_ctrl  = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };

    ESP_ERROR_CHECK(uart_param_config(CAR_UART_PORT, &uart_config));
    ESP_ERROR_CHECK(uart_set_pin(
        CAR_UART_PORT,
        CAR_UART_TX_GPIO,
        CAR_UART_RX_GPIO,
        UART_PIN_NO_CHANGE,
        UART_PIN_NO_CHANGE
    ));
    ESP_ERROR_CHECK(uart_driver_install(
        CAR_UART_PORT,
        CAR_UART_RX_BUF,
        0, 0, NULL, 0
    ));

    ESP_LOGI(TAG, "UART1 ready: TX=GPIO5, RX=GPIO6, %d baud", CAR_UART_BAUD_RATE);
    return ESP_OK;
}

esp_err_t uart_stm32_send_frame(const char *frame)
{
    if (!frame) return ESP_ERR_INVALID_ARG;
    size_t len = strlen(frame);
    uart_flush_input(CAR_UART_PORT);
    uart_write_bytes(CAR_UART_PORT, frame, len);
    uart_wait_tx_done(CAR_UART_PORT, pdMS_TO_TICKS(100));
    ESP_LOGI(TAG, "TX: %s", frame);
    return ESP_OK;
}

void uart_stm32_read_response(char *buf, size_t bufsz)
{
    if (!buf || bufsz == 0) return;
    int len = uart_read_bytes(CAR_UART_PORT, (uint8_t *)buf, bufsz - 1, pdMS_TO_TICKS(200));
    if (len > 0) {
        buf[len] = '\0';
        ESP_LOGI(TAG, "RX: %s", buf);
    } else {
        buf[0] = '\0';
    }
}

/**
 * Build and send a motion frame to STM32.
 *   direction: '0'=stop, '1'=forward, '2'=back, '3'=left, '4'=right
 *   spin:      0=no spin, 1=spin left, 2=spin right
 *   speed:     0~1000 (0=default, the STM32 increments by 100 per step)
 * Format:     $<dir>,0,0,<spin>,0,0,<speed>,0,0,0#
 */
void uart_stm32_send_motion(char direction, int spin, int speed)
{
    char frame[32];
    int spd_step = speed / 100;
    if (spd_step < 0) spd_step = 0;
    if (spd_step > 9) spd_step = 9;

    snprintf(frame, sizeof(frame), "$%c,0,0,%d,0,0,%d,0,0,0#",
             direction, spin, spd_step);

    uart_stm32_send_frame(frame);

    /* Read the EXEC response from STM32 (non-blocking) */
    char resp[64];
    uart_stm32_read_response(resp, sizeof(resp));
}
