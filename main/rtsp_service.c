/*
 * rtsp_service.c — RTSP server using esp_media_protocols
 *
 * Reference: espressif-demo/cam/esp32p4_rtsp_demo
 *
 * ⚠ Design note: video_start() is called once from main.c BEFORE this
 *   service starts, so the camera + H.264 encoder pipeline runs
 *   continuously regardless of RTSP client connections.
 *
 *   On TEARDOWN we do NOT stop the pipeline — stopping and restarting
 *   V4L2 M2M devices frequently causes "no valid buffer" errors and
 *   mmap conflicts.  The pipeline keeps encoding frames into buffers;
 *   on the next PLAY the RTSP callback simply starts reading them.
 *
 *   video_stop() is called only from main.c on system shutdown
 *   or via the TEARDOWN state if the pipeline was not pre-started
 *   (the else branch below).
 */
#include <string.h>
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "rtsp_service.h"
#include "media_lib_adapter.h"
#include "media_lib_netif.h"

static const char *TAG = "RTSP_SRV";
static uint32_t stream_first_pts = 0;
static int s_width = 1280, s_height = 720;

static uint32_t get_cur_pts(void) {
    uint32_t cur = 0;
    if (stream_first_pts == 0) {
        stream_first_pts = esp_timer_get_time() / 1000;
        cur = 0;
    } else {
        cur = esp_timer_get_time() / 1000 - stream_first_pts;
    }
    return cur;
}

static char *rtsp_get_network_ip(void) {
    media_lib_ipv4_info_t ip_info;
    media_lib_netif_get_ipv4_info(MEDIA_LIB_NET_TYPE_STA, &ip_info);
    return media_lib_ipv4_ntoa(&ip_info.ip);
}

static int rtsp_state_handler(esp_rtsp_state_t state, void *ctx) {
    camera_context *cam_ctx = (camera_context *)ctx;
    switch ((int)state) {
        case RTSP_STATE_SETUP:
            ESP_LOGI(TAG, "RTSP SETUP [new client connecting]");
            break;
        case RTSP_STATE_PLAY:
            stream_first_pts = 0;
            video_set_rtsp_streaming(true);
            if (cam_ctx->started) {
                ESP_LOGI(TAG, "RTSP PLAY");
            } else {
                ESP_LOGI(TAG, "RTSP PLAY — starting pipeline");
                if (video_start(s_width, s_height, cam_ctx) != ESP_OK) {
                    ESP_LOGE(TAG, "video_start failed");
                }
            }
            break;
        case RTSP_STATE_TEARDOWN:
            stream_first_pts = 0;
            video_set_rtsp_streaming(false);
            ESP_LOGI(TAG, "RTSP TEARDOWN");
            /*
             * Do NOT call video_stop() here.  The V4L2 capture + M2M codec
             * pipeline continues to run so the next PLAY finds valid buffers
             * already queued.  Calling video_stop() to then re-video_start()
             * risks mmap conflicts and "no valid buffer" errors in the
             * esp_video / h.264 driver layers.
             */
            break;
        default:
            break;
    }
    return 0;
}

static int rtsp_send_video(unsigned char *data, unsigned int *len,
                           uint32_t *pts, void *ctx) {
    camera_context *cam_ctx = (camera_context *)ctx;
    const frame_buffer_t *fb = video_fb_get(cam_ctx);
    if (!fb || !fb->buf) { *len = 0; return -1; }
    memcpy(data, fb->buf, fb->len);
    *len = fb->len;
    video_after_take(cam_ctx);
    *pts = get_cur_pts();
    return 0;
}

esp_rtsp_handle_t rtsp_service_start(camera_context *av_stream) {
    media_lib_add_default_adapter();

    /*
     * vcodec_info dimension convention follows the esp_media_protocols RTSP
     * component.  The "width" and "height" fields describe the video track,
     * not the sensor orientation — map them directly.
     */
    esp_rtsp_video_info_t vcodec_info = {
        .vcodec = RTSP_VCODEC_H264,
        .width  = s_width,
        .height = s_height,
        .fps    = 25,  /* slightly below pipeline max (~30fps) for headroom */
        .len    = s_width * s_height * 2,  /* generous upper bound for H.264 frame */
    };

    esp_rtsp_data_cb_t data_cb = {
        .send_audio = NULL,
        .receive_audio = NULL,
        .send_video = rtsp_send_video,
    };

    esp_rtsp_config_t rtsp_config = {
        .mode         = RTSP_SERVER,
        .ctx          = av_stream,
        .data_cb      = &data_cb,
        .audio_enable = false,
        .video_enable = true,
        .acodec       = RTSP_ACODEC_G711A,
        .video_info   = &vcodec_info,
        .local_addr   = rtsp_get_network_ip(),
        .stack_size   = RTSP_STACK_SZIE,
        .task_prio    = RTSP_TASK_PRIO,
        .state        = rtsp_state_handler,
        .trans        = RTSP_TRANSPORT_TCP,
        .local_port   = RTSP_SERVER_PORT,
    };

    esp_rtsp_handle_t h = esp_rtsp_server_start(&rtsp_config);
    if (h) {
        ESP_LOGI(TAG, "RTSP server started at rtsp://%s:%d (%dx%d %dfps, TCP)",
                 rtsp_get_network_ip(), RTSP_SERVER_PORT,
                 s_width, s_height, vcodec_info.fps);
    }
    return h;
}

int rtsp_service_stop(esp_rtsp_handle_t h) {
    if (h) esp_rtsp_server_stop(h);
    return 0;
}
