#pragma once
#include "esp_err.h"

esp_err_t uart_stm32_init(void);
esp_err_t uart_stm32_send_frame(const char *frame);
void uart_stm32_read_response(char *buf, size_t bufsz);
void uart_stm32_send_motion(char direction, int spin, int speed);
