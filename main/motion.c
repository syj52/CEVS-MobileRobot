/*
 * motion.c — Convert CMD:NAV waypoints to STM32 motor frames
 *
 * No odometry feedback in v1 — time-based movement estimation.
 * Protocol frame: $<dir>,0,0,<spin>,0,0,<speed>,0,0,0#
 */
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "uart_stm32.h"
#include "motion.h"

static const char *TAG = "MOTION";

#define SPIN_SPEED   5
#define DRIVE_SPEED  5
#define MS_PER_90DEG 400
#define MS_PER_METER 8000

static volatile motion_state_t s_state = MOTION_IDLE;
static float s_current_angle = 0.0f;

static void build_frame(char *buf, size_t sz, int dir, int spin, int speed)
{
    snprintf(buf, sz, "$%d,0,0,%d,0,0,%d,0,0,0#", dir, spin, speed);
}

static void send_and_wait(const char *frame, uint32_t delay_ms)
{
    uart_stm32_send(frame);
    if (delay_ms > 0) vTaskDelay(pdMS_TO_TICKS(delay_ms));
}

typedef struct { float target_x, target_y, cur_x, cur_y; } motion_params_t;

static void motion_task(void *arg)
{
    motion_params_t *p = (motion_params_t *)arg;
    if (!p) { vTaskDelete(NULL); return; }

    float dx = p->target_x - p->cur_x;
    float dy = p->target_y - p->cur_y;
    float dist = sqrtf(dx * dx + dy * dy);
    float target_angle = atan2f(dy, dx);

    ESP_LOGI(TAG, "Navigate: (%.2f,%.2f) -> (%.2f,%.2f)  dist=%.2f",
             p->cur_x, p->cur_y, p->target_x, p->target_y, (double)dist);
    free(p);

    if (dist < 0.01f) { s_state = MOTION_IDLE; vTaskDelete(NULL); return; }

    s_state = MOTION_TURNING;
    float delta = target_angle - s_current_angle;
    while (delta > 3.14159f) delta -= 2.0f * 3.14159f;
    while (delta < -3.14159f) delta += 2.0f * 3.14159f;

    if (fabsf(delta) > 0.05f) {
        int spin_dir = (delta > 0) ? 1 : 2;
        uint32_t t = (uint32_t)(fabsf(delta) / (3.14159f / 2.0f) * MS_PER_90DEG);
        if (t < 50) t = 50;
        char f[32]; build_frame(f, sizeof(f), 0, spin_dir, SPIN_SPEED);
        send_and_wait(f, t);
        send_and_wait("$0,0,0,0,0,0,0,0,0,0#", 100);
        s_current_angle = target_angle;
    }

    s_state = MOTION_MOVING;
    uint32_t drive_ms = (uint32_t)(dist * MS_PER_METER);
    if (drive_ms < 100) drive_ms = 100;
    char fwd[32]; build_frame(fwd, sizeof(fwd), 1, 0, DRIVE_SPEED);
    send_and_wait(fwd, drive_ms);
    send_and_wait("$0,0,0,0,0,0,0,0,0,0#", 0);

    s_state = MOTION_IDLE;
    ESP_LOGI(TAG, "Arrived");
    vTaskDelete(NULL);
}

esp_err_t motion_init(void)
{
    s_state = MOTION_IDLE;
    s_current_angle = 0.0f;
    ESP_LOGI(TAG, "Motion controller ready");
    return ESP_OK;
}

esp_err_t motion_nav_to(float x, float y, float speed)
{
    (void)speed;
    if (s_state != MOTION_IDLE) return ESP_ERR_INVALID_STATE;
    motion_params_t *p = malloc(sizeof(motion_params_t));
    if (!p) return ESP_ERR_NO_MEM;
    p->target_x = x; p->target_y = y; p->cur_x = 0; p->cur_y = 0;
    if (xTaskCreatePinnedToCore(motion_task, "motion", 3072, p,
                                tskIDLE_PRIORITY + 2, NULL, 0) != pdPASS) {
        free(p); return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t motion_stop(void)
{
    s_state = MOTION_IDLE;
    uart_stm32_send("$0,0,0,0,0,0,0,0,0,0#");
    return ESP_OK;
}

motion_state_t motion_get_state(void) { return s_state; }

esp_err_t motion_send_raw(const char *frame) { return uart_stm32_send(frame); }
