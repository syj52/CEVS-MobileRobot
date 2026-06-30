#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

esp_err_t motion_init(void);
esp_err_t motion_nav_to(float x, float y, float speed);
esp_err_t motion_stop(void);

typedef enum { MOTION_IDLE, MOTION_TURNING, MOTION_MOVING } motion_state_t;
motion_state_t motion_get_state(void);

esp_err_t motion_send_raw(const char *frame);
