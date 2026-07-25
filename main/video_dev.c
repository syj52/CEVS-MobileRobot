/*
 * video_dev.c — ESP-Video + JPEG hardware encoder for MJPEG streaming
 *
 * V4L2 capture (UYVY) → JPEG HW M2M encoder → TCP to server → WebSocket
 *
 * Uses V4L2 M2M JPEG encoder (/dev/video10) instead of H.264 for
 * sub-200ms latency.  V4L2 handles all buffer management and cache
 * coherence so there's no tearing or flickering.
 *
 * Camera → ISP converts RAW10 → UYVY (YUV422 packed, 2 bytes/px)
 * JPEG encoder input: UYVY  → output: JPEG (VIA_PIX_FMT_JPEG)
 */
#include <string.h>
#include <fcntl.h>
#include <errno.h>
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
static int s_width = 640, s_height = 360;

static i2c_master_bus_handle_t s_i2c_bus = NULL;

/* ── Helper ──────────────────────────────────────────────── */
static void clear_v4l2_buffer(struct v4l2_buffer *b, int type, int memory) {
    memset(b, 0, sizeof(*b));
    b->type   = type;
    b->memory = memory;
}

/* ── Init capture device ─────────────────────────────────── */
static esp_err_t init_capture(camera_context *ctx) {
    int fd = open(CAM_DEV_PATH, O_RDONLY);
    if (fd < 0) { ESP_LOGE(TAG, "open %s: %d", CAM_DEV_PATH, errno); return ESP_FAIL; }
    ctx->cap_fd = fd;
    ESP_LOGI(TAG, "Capture fd=%d", fd);
    return ESP_OK;
}

/* ── Init JPEG encoder M2M device ────────────────────────── */
static esp_err_t init_jpeg_encoder(camera_context *ctx) {
    int fd = open(ENCODE_DEV_PATH, O_RDONLY);
    if (fd < 0) {
        ESP_LOGE(TAG, "open %s: %d (try /dev/video10)", ENCODE_DEV_PATH, errno);
        /* Fallback: try /dev/video10 directly */
        fd = open("/dev/video10", O_RDONLY);
        if (fd < 0) { ESP_LOGE(TAG, "open /dev/video10: %d", errno); return ESP_FAIL; }
    }
    ctx->m2m_fd = fd;
    ESP_LOGI(TAG, "JPEG encoder fd=%d", fd);

    /* Set JPEG quality (1-100, higher = better) */
    struct v4l2_ext_controls ctrls;
    struct v4l2_ext_control ctl[1];
    memset(&ctrls, 0, sizeof(ctrls));
    ctrls.ctrl_class = V4L2_CID_JPEG_CLASS;
    ctrls.count = 1;
    ctrls.controls = ctl;
    ctl[0].id = V4L2_CID_JPEG_COMPRESSION_QUALITY;
    ctl[0].value = 30;  /* lower quality → smaller frames → fits esp_hosted link */
    ioctl(fd, VIDIOC_S_EXT_CTRLS, &ctrls);

    ESP_LOGI(TAG, "JPEG quality=80");
    return ESP_OK;
}

/* ── Init ────────────────────────────────────────────────── */
int video_dev_init(camera_context *context) {
    assert(context);
    memset(context, 0, sizeof(*context));
    context->cap_fd = -1;
    context->m2m_fd = -1;
    context->first_call = true;
    context->started = false;
    context->pending_requeue_idx = -1;

    /* Create shared I2C bus (GPIO8/7) */
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

    /* Init esp_video */
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

    /* Open V4L2 capture + JPEG codec devices */
    if (init_capture(context) != ESP_OK) {
        ESP_LOGE(TAG, "Capture device init failed — check camera wiring");
        return -1;
    }
    if (init_jpeg_encoder(context) != ESP_OK) {
        ESP_LOGE(TAG, "JPEG encoder init failed — check Kconfig: CONFIG_ESP_VIDEO_ENABLE_HW_JPEG_VIDEO_DEVICE");
        ESP_LOGE(TAG, "Run: idf.py reconfigure, then enable 'Hardware JPEG Video Device'");
        return -1;
    }
    ESP_LOGI(TAG, "Video + JPEG ready");
    return 0;
}

i2c_master_bus_handle_t video_get_i2c_bus(void) { return s_i2c_bus; }

/* ── Start streaming ─────────────────────────────────────── */
esp_err_t video_start(int width, int height, camera_context *cb_ctx) {
    s_width = width; s_height = height;
    /* RGB565 — CSI + JPEG encoder both support it at 1280×720 (confirmed working) */
    uint32_t cap_fmt = V4L2_PIX_FMT_RGB565;
    struct v4l2_format fmt;
    struct v4l2_buffer buf;
    struct v4l2_requestbuffers req;

    /* ── Camera capture ──────────────────────────────────── */
    memset(&fmt, 0, sizeof(fmt));
    fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    fmt.fmt.pix.width = width; fmt.fmt.pix.height = height;
    fmt.fmt.pix.pixelformat = cap_fmt;
    if (ioctl(cb_ctx->cap_fd, VIDIOC_S_FMT, &fmt) != 0)
        { ESP_LOGE(TAG, "S_FMT capture: %d", errno); return ESP_FAIL; }

    memset(&req, 0, sizeof(req));
    req.count = BUFFER_COUNT; req.type = V4L2_BUF_TYPE_VIDEO_CAPTURE; req.memory = V4L2_MEMORY_MMAP;
    if (ioctl(cb_ctx->cap_fd, VIDIOC_REQBUFS, &req) != 0)
        { ESP_LOGE(TAG, "REQBUFS cap: %d", errno); return ESP_FAIL; }

    for (int i = 0; i < BUFFER_COUNT; i++) {
        clear_v4l2_buffer(&buf, V4L2_BUF_TYPE_VIDEO_CAPTURE, V4L2_MEMORY_MMAP);
        buf.index = i;
        ioctl(cb_ctx->cap_fd, VIDIOC_QUERYBUF, &buf);
        cb_ctx->cap_buffer[i] = mmap(NULL, buf.length, PROT_READ|PROT_WRITE,
                                     MAP_SHARED, cb_ctx->cap_fd, buf.m.offset);
        if (cb_ctx->cap_buffer[i] == MAP_FAILED)
            { ESP_LOGE(TAG, "mmap cap[%d]: %d", i, errno); return ESP_FAIL; }
        ioctl(cb_ctx->cap_fd, VIDIOC_QBUF, &buf);
    }

    /* ── JPEG encoder OUTPUT (input format = UYVY) ───────── */
    memset(&fmt, 0, sizeof(fmt));
    fmt.type = V4L2_BUF_TYPE_VIDEO_OUTPUT;
    fmt.fmt.pix.width = width; fmt.fmt.pix.height = height;
    fmt.fmt.pix.pixelformat = cap_fmt;
    if (ioctl(cb_ctx->m2m_fd, VIDIOC_S_FMT, &fmt) != 0)
        { ESP_LOGE(TAG, "S_FMT JPEG out: %d", errno); return ESP_FAIL; }

    memset(&req, 0, sizeof(req));
    req.count = 1; req.type = V4L2_BUF_TYPE_VIDEO_OUTPUT; req.memory = V4L2_MEMORY_USERPTR;
    if (ioctl(cb_ctx->m2m_fd, VIDIOC_REQBUFS, &req) != 0)
        { ESP_LOGE(TAG, "REQBUFS JPEG out: %d", errno); return ESP_FAIL; }

    /* ── JPEG encoder CAPTURE (output format = JPEG) ─────── */
    memset(&fmt, 0, sizeof(fmt));
    fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    fmt.fmt.pix.width = width; fmt.fmt.pix.height = height;
    fmt.fmt.pix.pixelformat = V4L2_PIX_FMT_JPEG;
    if (ioctl(cb_ctx->m2m_fd, VIDIOC_S_FMT, &fmt) != 0)
        { ESP_LOGE(TAG, "S_FMT JPEG cap: %d", errno); return ESP_FAIL; }

    memset(&req, 0, sizeof(req));
    req.count = M2M_CAP_COUNT; req.type = V4L2_BUF_TYPE_VIDEO_CAPTURE; req.memory = V4L2_MEMORY_MMAP;
    if (ioctl(cb_ctx->m2m_fd, VIDIOC_REQBUFS, &req) != 0)
        { ESP_LOGE(TAG, "REQBUFS JPEG cap: %d", errno); return ESP_FAIL; }

    for (int i = 0; i < M2M_CAP_COUNT; i++) {
        clear_v4l2_buffer(&buf, V4L2_BUF_TYPE_VIDEO_CAPTURE, V4L2_MEMORY_MMAP);
        buf.index = i;
        ioctl(cb_ctx->m2m_fd, VIDIOC_QUERYBUF, &buf);
        cb_ctx->m2m_cap_buffer[i] = mmap(NULL, buf.length, PROT_READ|PROT_WRITE,
                                         MAP_SHARED, cb_ctx->m2m_fd, buf.m.offset);
        if (cb_ctx->m2m_cap_buffer[i] == MAP_FAILED)
            { ESP_LOGE(TAG, "mmap jpeg[%d]: %d", i, errno); return ESP_FAIL; }
        ioctl(cb_ctx->m2m_fd, VIDIOC_QBUF, &buf);
    }

    /* ── Start streams ───────────────────────────────────── */
    int type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    ioctl(cb_ctx->m2m_fd, VIDIOC_STREAMON, &type);
    type = V4L2_BUF_TYPE_VIDEO_OUTPUT;
    ioctl(cb_ctx->m2m_fd, VIDIOC_STREAMON, &type);
    type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    ioctl(cb_ctx->cap_fd, VIDIOC_STREAMON, &type);

    cb_ctx->pre_fed = false;
    cb_ctx->first_call = true;
    cb_ctx->started = true;
    cb_ctx->pending_requeue_idx = -1;

    ESP_LOGI(TAG, "Stream %dx%d UYVY→JPEG (cap=%d jpeg=%d)", width, height, BUFFER_COUNT, M2M_CAP_COUNT);
    return ESP_OK;
}

/* ── Feed camera frame → JPEG encoder ────────────────────── */
static void feed_encoder(camera_context *cb_ctx, int cap_buf_idx, uint32_t bytes_used) {
    struct v4l2_buffer m2m_out;
    clear_v4l2_buffer(&m2m_out, V4L2_BUF_TYPE_VIDEO_OUTPUT, V4L2_MEMORY_USERPTR);
    m2m_out.index = 0;
    m2m_out.m.userptr = (unsigned long)cb_ctx->cap_buffer[cap_buf_idx];
    m2m_out.length = bytes_used;
    ioctl(cb_ctx->m2m_fd, VIDIOC_QBUF, &m2m_out);
    cb_ctx->pre_fed = true;
    cb_ctx->fed_cap_idx = cap_buf_idx;
}

/* ── Collect JPEG output ─────────────────────────────────── */
static int collect_encoded(camera_context *cb_ctx) {
    struct v4l2_buffer m2m_cap;
    clear_v4l2_buffer(&m2m_cap, V4L2_BUF_TYPE_VIDEO_CAPTURE, V4L2_MEMORY_MMAP);
    if (ioctl(cb_ctx->m2m_fd, VIDIOC_DQBUF, &m2m_cap) != 0)
        { ESP_LOGE(TAG, "DQBUF JPEG: %d", errno); return -1; }

    cb_ctx->fb.buf = cb_ctx->m2m_cap_buffer[m2m_cap.index];
    cb_ctx->fb.len = m2m_cap.bytesused;
    cb_ctx->fb.width = s_width; cb_ctx->fb.height = s_height;
    cb_ctx->last_enc_cap_idx = m2m_cap.index;
    return m2m_cap.index;
}

/* ── Clean up encoder OUTPUT buffer ──────────────────────── */
static void cleanup_encoder_output(camera_context *cb_ctx) {
    struct v4l2_buffer m2m_out;
    clear_v4l2_buffer(&m2m_out, V4L2_BUF_TYPE_VIDEO_OUTPUT, V4L2_MEMORY_USERPTR);
    ioctl(cb_ctx->m2m_fd, VIDIOC_DQBUF, &m2m_out);
}

/* ── Return camera buffer ────────────────────────────────── */
static void return_camera_buffer(camera_context *cb_ctx, int index) {
    struct v4l2_buffer cap_buf;
    clear_v4l2_buffer(&cap_buf, V4L2_BUF_TYPE_VIDEO_CAPTURE, V4L2_MEMORY_MMAP);
    cap_buf.index = index;
    ioctl(cb_ctx->cap_fd, VIDIOC_QBUF, &cap_buf);
}

/* ── Dequeue camera frame ────────────────────────────────── */
static int dequeue_camera(camera_context *cb_ctx, struct v4l2_buffer *cap_buf) {
    clear_v4l2_buffer(cap_buf, V4L2_BUF_TYPE_VIDEO_CAPTURE, V4L2_MEMORY_MMAP);
    if (ioctl(cb_ctx->cap_fd, VIDIOC_DQBUF, cap_buf) != 0)
        { ESP_LOGE(TAG, "DQBUF camera: %d", errno); return -1; }
    return 0;
}

/* ═══════════════════════════════════════════════════════════
 * video_fb_get — Pipelined frame capture + JPEG encode
 *
 * Same pipeline as before but with JPEG instead of H.264.
 * Camera UYVY → JPEG HW encoder → return JPEG buffer
 * ═══════════════════════════════════════════════════════════ */
frame_buffer_t *video_fb_get(camera_context *cb_ctx) {
    struct v4l2_buffer cap_buf;
    bool have_result = false;

    /* Self-healing: requeue any buffer that video_after_take didn't return */
    if (cb_ctx->pending_requeue_idx >= 0) {
        struct v4l2_buffer self_b;
        clear_v4l2_buffer(&self_b, V4L2_BUF_TYPE_VIDEO_CAPTURE, V4L2_MEMORY_MMAP);
        self_b.index = cb_ctx->pending_requeue_idx;
        ioctl(cb_ctx->m2m_fd, VIDIOC_QBUF, &self_b);
        cb_ctx->pending_requeue_idx = -1;
    }

    /* Phase 1: Collect previously pre-fed encoded result */
    if (cb_ctx->pre_fed) {
        if (collect_encoded(cb_ctx) < 0) return NULL;
        have_result = true;
        cleanup_encoder_output(cb_ctx);
        return_camera_buffer(cb_ctx, cb_ctx->fed_cap_idx);
        cb_ctx->pre_fed = false;
    }

    /* Phase 2: Dequeue a fresh camera frame */
    if (dequeue_camera(cb_ctx, &cap_buf) != 0) return NULL;

    /* Phase 3: Produce encoded result */
    if (!have_result) {
        /* First call: sync encode */
        feed_encoder(cb_ctx, cap_buf.index, cap_buf.bytesused);
        if (collect_encoded(cb_ctx) < 0) return NULL;
        have_result = true;
        cleanup_encoder_output(cb_ctx);
        return_camera_buffer(cb_ctx, cap_buf.index);
        cb_ctx->pre_fed = false;

        /* Pre-feed a second frame for pipelining */
        struct v4l2_buffer cap_buf2;
        if (dequeue_camera(cb_ctx, &cap_buf2) == 0) {
            feed_encoder(cb_ctx, cap_buf2.index, cap_buf2.bytesused);
        } else {
            cb_ctx->pre_fed = false;
        }
        cb_ctx->first_call = false;
    } else {
        /* Normal path: pre-feed next frame */
        feed_encoder(cb_ctx, cap_buf.index, cap_buf.bytesused);
    }

    return &cb_ctx->fb;
}

/* ── Mark buffer for requeue (called after sending JPEG) ── */
void video_after_take(camera_context *cb_ctx) {
    cb_ctx->pending_requeue_idx = cb_ctx->last_enc_cap_idx;
}

/* ── Stop ────────────────────────────────────────────────── */
void video_stop(camera_context *cb_ctx) {
    struct v4l2_buffer dummy;
    for (int i = 0; i < M2M_CAP_COUNT + 2; i++) {
        clear_v4l2_buffer(&dummy, V4L2_BUF_TYPE_VIDEO_CAPTURE, V4L2_MEMORY_MMAP);
        if (ioctl(cb_ctx->m2m_fd, VIDIOC_DQBUF, &dummy) != 0) break;
        ioctl(cb_ctx->m2m_fd, VIDIOC_QBUF, &dummy);
    }
    vTaskDelay(pdMS_TO_TICKS(50));

    int type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    ioctl(cb_ctx->cap_fd, VIDIOC_STREAMOFF, &type);
    type = V4L2_BUF_TYPE_VIDEO_OUTPUT;
    ioctl(cb_ctx->m2m_fd, VIDIOC_STREAMOFF, &type);
    type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    ioctl(cb_ctx->m2m_fd, VIDIOC_STREAMOFF, &type);

    cb_ctx->pre_fed = false;
    cb_ctx->first_call = true;
    cb_ctx->started = false;
    cb_ctx->pending_requeue_idx = -1;
    ESP_LOGI(TAG, "Stream stopped");
}

void video_get_resolution(int *w, int *h) { if (w) *w = s_width; if (h) *h = s_height; }
