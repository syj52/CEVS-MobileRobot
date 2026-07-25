#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

/** Latest odometry from STM32 $ODOM frames (4-wheel encoder counts) */
typedef struct {
    int32_t enc[4];
} stm32_odom_t;

esp_err_t uart_stm32_init(void (*rx_callback)(const char *line));
esp_err_t uart_stm32_send(const char *frame);  /* direct UART write, no queue */
bool      uart_stm32_is_ready(void);

/** Read the latest decoded odometry (non-blocking, ISR-safe). */
void      uart_stm32_get_odom(stm32_odom_t *out);

/** Read the latest IMU yaw angle in degrees (from $IMU EULER field). */
float     uart_stm32_get_yaw(void);
