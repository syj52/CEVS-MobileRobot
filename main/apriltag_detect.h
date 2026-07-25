#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

/** Called from the video pipeline task (main.c) for each raw Y frame.
 *  Copies the Y plane into an internal double-buffer for async detection.
 *  Must be fast (< 1 ms) — called from within video_fb_get(). */
void apriltag_on_raw_frame(const uint8_t *y_plane, int width, int height);

/** Initialize the AprilTag detection subsystem.
 *  Must be called after video_dev_init() and the pipeline task is running.
 *  Creates a FreeRTOS task that processes frames from the raw-frame callback
 *  and sends $ATAG frames over TCP.
 */
esp_err_t apriltag_detect_init(void);

/** Override the physical tag black-border width (mm).
 *  Default: 70 mm.  Must match the printed/displayed tag size. */
esp_err_t apriltag_detect_set_tag_size(float size_mm);

/** True once the detection task is running */
bool apriltag_detect_is_running(void);
