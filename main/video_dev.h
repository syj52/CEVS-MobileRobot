#ifndef VIDEO_DEV_H
#define VIDEO_DEV_H

#include <esp_cam_sensor_types.h>
#include <stddef.h>
#include <stdint.h>
#include <linux/videodev2.h>

#define CAM_DEV_PATH        ESP_VIDEO_MIPI_CSI_DEVICE_NAME
#define ENCODE_DEV_PATH     ESP_VIDEO_H264_DEVICE_NAME

#define BUFFER_COUNT        2

typedef struct {
    uint8_t *buf;
    size_t len;
    size_t width;
    size_t height;
    struct timeval timestamp;
} frame_buffer_t;

typedef struct {
    int cap_fd;                     /* camera capture fd */
    uint32_t format;                /* output format (V4L2_PIX_FMT_H264) */
    uint8_t *cap_buffer[BUFFER_COUNT]; /* camera DMA buffers */
    int m2m_fd;                     /* M2M codec fd */
    uint8_t *m2m_cap_buffer;        /* codec output buffer */
    frame_buffer_t fb;              /* current frame */
} camera_context;

int  video_dev_init(camera_context *context);
esp_err_t video_start(int width, int height, camera_context *cb_ctx);
frame_buffer_t *video_fb_get(camera_context *cb_ctx);
void video_after_take(const camera_context *cb_ctx);
void video_stop(camera_context *cb_ctx);
void video_get_resolution(int *w, int *h);

/* Expose shared I2C bus for audio codec */
#include "driver/i2c_master.h"
i2c_master_bus_handle_t video_get_i2c_bus(void);

#endif
