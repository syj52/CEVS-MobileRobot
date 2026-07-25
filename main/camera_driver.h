#pragma once
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

esp_err_t camera_init(void);
esp_err_t camera_start(void);
esp_err_t camera_grab_frame(uint8_t **buf, size_t *len);
void camera_return_frame(void);
void camera_get_resolution(uint16_t *w, uint16_t *h);
esp_err_t camera_deinit(void);
