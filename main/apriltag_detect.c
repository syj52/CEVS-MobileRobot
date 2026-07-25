/*
 * apriltag_detect.c — AprilTag detection on ESP32-P4
 *
 * Receives raw YUV420 Y-plane frames via apriltag_on_raw_frame()
 * (called from video_fb_get()'s raw-frame callback).
 * Detects tag36h11 tags and sends $ATAG frames over TCP.
 *
 * Output: $ATAG:id=%d,tx=%.3f,ty=%.3f,tz=%.3f,yaw=%.1f\r\n
 *
 * ⚠ The camera must be streaming for this to work.
 *   video_start() is called from main.c independently of RTSP.
 */
#include <stdio.h>
#include <string.h>
#include <math.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"

#include "apriltag.h"
#include "tag36h11.h"
#include "apriltag_pose.h"

#include "network/tcp_client.h"
#include "apriltag_detect.h"

static const char *TAG = "ATAG";

/* ─── Constants — matches video_dev.c 1280×720 ──────────────── */
#define CAM_W       1280
#define CAM_H       720
#define CAM_FX      800.0f
#define CAM_FY      800.0f
#define CAM_CX      640.0f
#define CAM_CY      360.0f

#define DEFAULT_TAG_SIZE_MM  70.0f

/*
 * Detection interval.  With the pipelined video_fb_get producing ~30fps
 * callbacks and skip=60, a fresh Y-plane arrives every ~2s.
 * DETECT_INTERVAL_MS is set slightly longer than the capture interval
 * to avoid processing the same frame twice.
 */
#define DETECT_INTERVAL_MS   2500

/*
 * Frame skip in the callback.  At ~30fps effective pipeline rate:
 *   skip=60 → ~2s between captured frames.
 *   skip=30 → ~1s (faster updates, more CPU load).
 */
#define FRAME_SKIP_COUNT     60

/* ─── Static state ─────────────────────────────────────────────── */
static TaskHandle_t s_task     = NULL;
static bool         s_running  = false;
static float        s_tag_size = DEFAULT_TAG_SIZE_MM;

/* Double-buffered frame + ready flag */
static uint8_t     *s_frame[2]   = { NULL, NULL };
static volatile int s_write_idx  = 0;   /* index callback writes to */
static volatile int s_read_idx   = 1;   /* index detect task reads from */
static volatile bool s_ready     = false;

/* Diagnostic: track last frame timestamp for stall detection */
static volatile int64_t s_last_frame_us = 0;

/* ─── Called from video_fb_get()'s raw-frame callback ────────── */
void apriltag_on_raw_frame(const uint8_t *y_plane, int w, int h)
{
    if (!s_frame[0] || !s_frame[1]) return;
    if (w != CAM_W || h != CAM_H) return;

    s_last_frame_us = esp_timer_get_time();

    /* Throttle: copy only 1 frame per FRAME_SKIP_COUNT callbacks */
    static uint32_t skip = 0;
    if (++skip < FRAME_SKIP_COUNT) return;
    skip = 0;

    memcpy(s_frame[s_write_idx], y_plane, CAM_W * CAM_H);
    s_read_idx = s_write_idx;
    s_write_idx = 1 - s_write_idx;
    s_ready = true;
}

/* ─── Detection task ────────────────────────────────────────────── */
static void detect_task(void *arg)
{
    (void)arg;

    apriltag_family_t *tf = tag36h11_create();
    if (!tf) { ESP_LOGE(TAG, "tag36h11_create failed"); vTaskDelete(NULL); return; }

    apriltag_detector_t *td = apriltag_detector_create();
    if (!td) { tag36h11_destroy(tf); ESP_LOGE(TAG, "detector_create failed"); vTaskDelete(NULL); return; }
    apriltag_detector_add_family_bits(td, tf, 1);

    /*
     * quad_decimate = 2.0 reduces the 1280×720 input to 640×360
     * for gradient computation, trading range for speed.
     * For tags < 10 px (after decimation), detection becomes unreliable.
     * A 70 mm tag at 2 m range is ~14 px — close to the limit.
     *
     * To increase detection range, reduce quad_decimate to 1.0,
     * but expect ~4× longer detection time (still within 2.5s interval).
     */
    td->quad_decimate = 2.0f;
    td->quad_sigma    = 0.0f;
    td->nthreads      = 1;
    td->debug         = false;

    /* Allocate double buffer in PSRAM (921,600 bytes each) */
    for (int i = 0; i < 2; i++) {
        s_frame[i] = (uint8_t *)heap_caps_malloc(CAM_W * CAM_H, MALLOC_CAP_SPIRAM);
        if (!s_frame[i]) {
            ESP_LOGE(TAG, "frame buffer %d OOM (PSRAM)", i);
            apriltag_detector_destroy(td);
            tag36h11_destroy(tf);
            vTaskDelete(NULL);
            return;
        }
    }

    ESP_LOGI(TAG, "Detector ready — tag=%.0fmm decimate=%.1f interval=%dms",
             s_tag_size, td->quad_decimate, DETECT_INTERVAL_MS);

    int no_data_count = 0;

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(DETECT_INTERVAL_MS));

        if (!s_ready) {
            no_data_count++;
            /* Warn if no frames for >30s (camera may not be streaming) */
            if (no_data_count == 1 || (no_data_count % 12) == 0) {
                ESP_LOGW(TAG, "No frames ready (%d cycles). "
                         "Is the camera streaming? Last callback: %lld ms ago",
                         no_data_count,
                         s_last_frame_us > 0
                            ? (long long)(esp_timer_get_time() - s_last_frame_us) / 1000
                            : -1LL);
            }
            continue;
        }
        no_data_count = 0;

        int idx = s_read_idx;
        image_u8_t im = {
            .width  = CAM_W,
            .height = CAM_H,
            .stride = CAM_W,
            .buf    = s_frame[idx]
        };

        int64_t t0 = esp_timer_get_time();
        zarray_t *detections = apriltag_detector_detect(td, &im);
        int64_t t1 = esp_timer_get_time();
        int ndet = detections ? zarray_size(detections) : 0;

        if (ndet > 0) {
            ESP_LOGI(TAG, "Found %d tag(s) in %lld ms", ndet, (long long)(t1 - t0) / 1000);
        }

        for (int i = 0; i < ndet; i++) {
            apriltag_detection_t *det;
            zarray_get(detections, i, &det);

            float tag_m = s_tag_size / 1000.0f;

            apriltag_detection_info_t info;
            info.det     = det;
            info.tagsize = tag_m;
            info.fx      = CAM_FX;
            info.fy      = CAM_FY;
            info.cx      = CAM_CX;
            info.cy      = CAM_CY;

            apriltag_pose_t pose;
            estimate_pose_for_tag_homography(&info, &pose);

            float tx = (float)matd_get(pose.t, 0, 0);
            float ty = (float)matd_get(pose.t, 1, 0);
            float tz = (float)matd_get(pose.t, 2, 0);

            float r11 = (float)matd_get(pose.R, 0, 0);
            float r21 = (float)matd_get(pose.R, 1, 0);
            float yaw_deg = atan2f(r21, r11) * 180.0f / 3.14159265f;

            char buf[160];
            int n = snprintf(buf, sizeof(buf),
                "$ATAG:id=%d,tx=%.3f,ty=%.3f,tz=%.3f,yaw=%.1f\r\n",
                det->id, (double)tx, (double)ty, (double)tz, (double)yaw_deg);
            if (n > 0 && n < (int)sizeof(buf)) tcp_client_send(buf);

            ESP_LOGI(TAG, "Tag %d: (%.2f,%.2f,%.2f)m yaw=%.0f° dist=%.2fm",
                     det->id, (double)tx, (double)ty, (double)tz, (double)yaw_deg, (double)tz);

            matd_destroy(pose.R);
            matd_destroy(pose.t);
        }
        if (detections) apriltag_detections_destroy(detections);

        s_ready = false;
    }

    /* Unreachable */
    apriltag_detector_destroy(td);
    tag36h11_destroy(tf);
    for (int i = 0; i < 2; i++) { if (s_frame[i]) free(s_frame[i]); s_frame[i] = NULL; }
    s_task = NULL; s_running = false;
    vTaskDelete(NULL);
}

/* ─── Public API ────────────────────────────────────────────────── */
esp_err_t apriltag_detect_init(void)
{
    if (s_task) return ESP_ERR_INVALID_STATE;

    /*
     * Stack: 10KB.  The apriltag library uses heap for detection data
     * structures, but its recursive quad-decoding and homography estimation
     * use significant stack space.  10KB has been tested stable for 720p.
     */
    BaseType_t ret = xTaskCreatePinnedToCore(
        detect_task, "apriltag", 10240, NULL,
        tskIDLE_PRIORITY + 1, &s_task, 1); /* CPU 1 — avoid blocking WiFi/lwIP on CPU 0 */
    if (ret != pdPASS) { s_task = NULL; return ESP_ERR_NO_MEM; }

    s_running = true;
    ESP_LOGI(TAG, "Task started (stack=10KB, cpu=1, skip=%d)", FRAME_SKIP_COUNT);
    return ESP_OK;
}

esp_err_t apriltag_detect_set_tag_size(float size_mm)
{
    if (size_mm < 10.0f || size_mm > 500.0f) return ESP_ERR_INVALID_ARG;
    s_tag_size = size_mm;
    ESP_LOGI(TAG, "Tag size = %.0f mm", (double)size_mm);
    return ESP_OK;
}

bool apriltag_detect_is_running(void) { return s_running; }
