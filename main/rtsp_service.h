#ifndef RTSP_SERVICE_H
#define RTSP_SERVICE_H
#include "esp_rtsp.h"
#include "video_dev.h"

#define RTSP_SERVER_PORT   8554
#define RTSP_STACK_SZIE    (10 * 1024)
#define RTSP_TASK_PRIO     5

esp_rtsp_handle_t rtsp_service_start(camera_context *av_stream);
int rtsp_service_stop(esp_rtsp_handle_t esp_rtsp);

#endif
