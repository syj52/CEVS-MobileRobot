/*
 * video_dev.c — ESP-Video + H.264 hardware encoder
 *
 * Adapted from espressif-demo/cam/esp32p4_rtsp_demo.
 * I2C bus is created once and shared with audio_mic via video_get_i2c_bus().
 */
#include <string.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_err.h"
#include "esp_log.h"
#include "driver/i2c_master.h"
#include "esp_video_init.h"
#include "esp_video_device.h"
#include "linux/videodev2.h"
#include "video_dev.h"

static const char *TAG = "VIDEO";
static int s_width = 1280, s_height = 720;

/* Shared I2C bus handle */
static i2c_master_bus_handle_t s_i2c_bus = NULL;

/* ── V4L2 capture device init ───────────────────────────────── */
static esp_err_t init_capture_video(camera_context *ctx) {
    int fd = open(CAM_DEV_PATH, O_RDONLY);
    if (fd < 0) { ESP_LOGE(TAG, "open %s failed", CAM_DEV_PATH); return ESP_FAIL; }
    ctx->cap_fd = fd;
    ESP_LOGI(TAG, "Capture fd=%d", fd);
    return ESP_OK;
}

/* ── H.264 M2M codec init ───────────────────────────────────── */
static esp_err_t init_codec_video(camera_context *ctx) {
    int fd = open(ENCODE_DEV_PATH, O_RDONLY);
    if (fd < 0) { ESP_LOGE(TAG, "open %s failed", ENCODE_DEV_PATH); return ESP_FAIL; }
    ctx->m2m_fd = fd;
    ctx->format = V4L2_PIX_FMT_H264;

    struct v4l2_ext_controls ctrls;
    struct v4l2_ext_control ctl[1];
    memset(&ctrls, 0, sizeof(ctrls));
    ctrls.ctrl_class = V4L2_CID_CODEC_CLASS;
    ctrls.count = 1;
    ctrls.controls = ctl;
    ctl[0].id = V4L2_CID_MPEG_VIDEO_H264_I_PERIOD;
    ctl[0].value = 30;
    ioctl(fd, VIDIOC_S_EXT_CTRLS, &ctrls);
    ctl[0].id = V4L2_CID_MPEG_VIDEO_BITRATE;
    ctl[0].value = 4000000;
    ioctl(fd, VIDIOC_S_EXT_CTRLS, &ctrls);

    ESP_LOGI(TAG, "H.264 codec fd=%d, I_PERIOD=30, 4Mbps", fd);
    return ESP_OK;
}

/* ── Init: I2C bus → esp_video → V4L2 devices ───────────────── */
int video_dev_init(camera_context *context) {
    assert(context);

    /* 1. Create shared I2C bus (GPIO8/7) — used by both camera & audio codec */
    i2c_master_bus_config_t i2c_cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = GPIO_NUM_7,
        .scl_io_num = GPIO_NUM_8,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&i2c_cfg, &s_i2c_bus));
    ESP_LOGI(TAG, "I2C bus ready (GPIO8/7)");

    /* 2. Init esp_video with existing I2C handle, not creating its own */
    esp_video_init_sccb_config_t sccb = {
        .init_sccb = false,
        .i2c_handle = s_i2c_bus,
        .freq = 400000,
    };
    esp_video_init_csi_config_t csi = {
        .sccb_config = sccb,
        .reset_pin = -1,
        .pwdn_pin = -1,
    };
    esp_video_init_config_t cam_config = { .csi = &csi };
    ESP_ERROR_CHECK(esp_video_init(&cam_config));

    /* 3. Open V4L2 capture + H.264 codec devices */
    ESP_ERROR_CHECK(init_capture_video(context));
    ESP_ERROR_CHECK(init_codec_video(context));
    ESP_LOGI(TAG, "Video + H.264 ready");
    return 0;
}

i2c_master_bus_handle_t video_get_i2c_bus(void) { return s_i2c_bus; }

/* ── Start streaming (called from RTSP on PLAY) ─────────────── */
esp_err_t video_start(int width, int height, camera_context *cb_ctx) {
    s_width = width; s_height = height;
    struct v4l2_format fmt;
    struct v4l2_buffer buf;
    struct v4l2_requestbuffers req;
    uint32_t cap_fmt = V4L2_PIX_FMT_YUV420;

    /* Camera capture */
    memset(&fmt, 0, sizeof(fmt));
    fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    fmt.fmt.pix.width = width; fmt.fmt.pix.height = height;
    fmt.fmt.pix.pixelformat = cap_fmt;
    ioctl(cb_ctx->cap_fd, VIDIOC_S_FMT, &fmt);

    memset(&req, 0, sizeof(req));
    req.count = BUFFER_COUNT; req.type = V4L2_BUF_TYPE_VIDEO_CAPTURE; req.memory = V4L2_MEMORY_MMAP;
    ioctl(cb_ctx->cap_fd, VIDIOC_REQBUFS, &req);
    for (int i = 0; i < BUFFER_COUNT; i++) {
        memset(&buf, 0, sizeof(buf));
        buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE; buf.memory = V4L2_MEMORY_MMAP; buf.index = i;
        ioctl(cb_ctx->cap_fd, VIDIOC_QUERYBUF, &buf);
        cb_ctx->cap_buffer[i] = mmap(NULL, buf.length, PROT_READ|PROT_WRITE, MAP_SHARED, cb_ctx->cap_fd, buf.m.offset);
        ioctl(cb_ctx->cap_fd, VIDIOC_QBUF, &buf);
    }

    /* Codec output */
    memset(&fmt, 0, sizeof(fmt));
    fmt.type = V4L2_BUF_TYPE_VIDEO_OUTPUT;
    fmt.fmt.pix.width = width; fmt.fmt.pix.height = height; fmt.fmt.pix.pixelformat = cap_fmt;
    ioctl(cb_ctx->m2m_fd, VIDIOC_S_FMT, &fmt);
    memset(&req, 0, sizeof(req));
    req.count = 1; req.type = V4L2_BUF_TYPE_VIDEO_OUTPUT; req.memory = V4L2_MEMORY_USERPTR;
    ioctl(cb_ctx->m2m_fd, VIDIOC_REQBUFS, &req);

    /* Codec capture (H.264) */
    memset(&fmt, 0, sizeof(fmt));
    fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    fmt.fmt.pix.width = width; fmt.fmt.pix.height = height; fmt.fmt.pix.pixelformat = V4L2_PIX_FMT_H264;
    ioctl(cb_ctx->m2m_fd, VIDIOC_S_FMT, &fmt);
    memset(&req, 0, sizeof(req));
    req.count = 1; req.type = V4L2_BUF_TYPE_VIDEO_CAPTURE; req.memory = V4L2_MEMORY_MMAP;
    ioctl(cb_ctx->m2m_fd, VIDIOC_REQBUFS, &req);
    memset(&buf, 0, sizeof(buf));
    buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE; buf.memory = V4L2_MEMORY_MMAP; buf.index = 0;
    ioctl(cb_ctx->m2m_fd, VIDIOC_QUERYBUF, &buf);
    cb_ctx->m2m_cap_buffer = mmap(NULL, buf.length, PROT_READ|PROT_WRITE, MAP_SHARED, cb_ctx->m2m_fd, buf.m.offset);
    ioctl(cb_ctx->m2m_fd, VIDIOC_QBUF, &buf);

    /* Start streams */
    int t = V4L2_BUF_TYPE_VIDEO_CAPTURE; ioctl(cb_ctx->m2m_fd, VIDIOC_STREAMON, &t);
    t = V4L2_BUF_TYPE_VIDEO_OUTPUT; ioctl(cb_ctx->m2m_fd, VIDIOC_STREAMON, &t);
    t = V4L2_BUF_TYPE_VIDEO_CAPTURE; ioctl(cb_ctx->cap_fd, VIDIOC_STREAMON, &t);
    ESP_LOGI(TAG, "Stream %dx%d H.264", width, height);
    return ESP_OK;
}

/* ── Get one encoded H.264 frame ────────────────────────────── */
frame_buffer_t *video_fb_get(camera_context *cb_ctx) {
    struct v4l2_buffer cap_buf, m2m_out, m2m_cap;
    memset(&cap_buf, 0, sizeof(cap_buf));
    cap_buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE; cap_buf.memory = V4L2_MEMORY_MMAP;
    ioctl(cb_ctx->cap_fd, VIDIOC_DQBUF, &cap_buf);

    memset(&m2m_out, 0, sizeof(m2m_out));
    m2m_out.index = 0; m2m_out.type = V4L2_BUF_TYPE_VIDEO_OUTPUT; m2m_out.memory = V4L2_MEMORY_USERPTR;
    m2m_out.m.userptr = (unsigned long)cb_ctx->cap_buffer[cap_buf.index];
    m2m_out.length = cap_buf.bytesused;
    ioctl(cb_ctx->m2m_fd, VIDIOC_QBUF, &m2m_out);

    memset(&m2m_cap, 0, sizeof(m2m_cap));
    m2m_cap.type = V4L2_BUF_TYPE_VIDEO_CAPTURE; m2m_cap.memory = V4L2_MEMORY_MMAP;
    ioctl(cb_ctx->m2m_fd, VIDIOC_DQBUF, &m2m_cap);

    ioctl(cb_ctx->cap_fd, VIDIOC_QBUF, &cap_buf);
    ioctl(cb_ctx->m2m_fd, VIDIOC_DQBUF, &m2m_out);

    cb_ctx->fb.buf = cb_ctx->m2m_cap_buffer;
    cb_ctx->fb.len = m2m_cap.bytesused;
    cb_ctx->fb.width = s_width; cb_ctx->fb.height = s_height;
    return &cb_ctx->fb;
}

void video_after_take(const camera_context *cb_ctx) {
    struct v4l2_buffer b;
    memset(&b, 0, sizeof(b)); b.index = 0;
    b.type = V4L2_BUF_TYPE_VIDEO_CAPTURE; b.memory = V4L2_MEMORY_MMAP;
    ioctl(cb_ctx->m2m_fd, VIDIOC_QBUF, &b);
}

void video_stop(camera_context *cb_ctx) {
    /* Drain codec capture buffers before stopping to avoid DMA race */
    struct v4l2_buffer dummy;
    for (int i = 0; i < 4; i++) {
        memset(&dummy, 0, sizeof(dummy));
        dummy.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        dummy.memory = V4L2_MEMORY_MMAP;
        if (ioctl(cb_ctx->m2m_fd, VIDIOC_DQBUF, &dummy) != 0) break;
        /* Re-queue to keep the buffer healthy */
        ioctl(cb_ctx->m2m_fd, VIDIOC_QBUF, &dummy);
    }
    vTaskDelay(pdMS_TO_TICKS(50));  /* wait for any in-flight DMA to settle */
    int t = V4L2_BUF_TYPE_VIDEO_CAPTURE; ioctl(cb_ctx->cap_fd, VIDIOC_STREAMOFF, &t);
    t = V4L2_BUF_TYPE_VIDEO_OUTPUT; ioctl(cb_ctx->m2m_fd, VIDIOC_STREAMOFF, &t);
    t = V4L2_BUF_TYPE_VIDEO_CAPTURE; ioctl(cb_ctx->m2m_fd, VIDIOC_STREAMOFF, &t);
}

void video_get_resolution(int *w, int *h) { if (w) *w = s_width; if (h) *h = s_height; }
