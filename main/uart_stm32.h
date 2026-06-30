#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

esp_err_t uart_stm32_init(void (*rx_callback)(const char *line));
esp_err_t uart_stm32_send(const char *frame);
bool uart_stm32_is_ready(void);
