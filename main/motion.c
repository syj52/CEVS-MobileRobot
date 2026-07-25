/*
 * motion.c �?Single-task motor execution with command queue.
 *
 * 3 entry points all go through one persistent task:
 *   motion_nav_to_pose() �?queue CMD:NAV
 *   motion_spin()        �?queue CMD:SPIN
 *   motion_stop() / motion_send_raw() �?direct send (no queue)
 *
 * New commands overwrite the old one �?the latest command always wins.
 */
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "uart_stm32.h"
#include "tcp_client.h"
#include "motion.h"

static const char *TAG = "MOTION";

/* ── Calibration ───────────────────────────────────────────── */
float g_turn_ms_per_deg = 5.0f;
float g_drive_ms_per_mm = 3.0f;

void motion_set_turn_cal(float v)  { g_turn_ms_per_deg = v; }
void motion_set_drive_cal(float v)  { g_drive_ms_per_mm = v; }

/* ── Encoder conversion ───────────────────────────────────── */
/* Calibrated: displayed distance was 1.25x actual → 0.1963/1.25 */
#define ENC_MM_PER_PULSE   0.1570f
#define TURN_TOLERANCE_DEG 3.0f
#define DRIVE_POLL_MS      30

static int32_t enc_avg(void) {
    stm32_odom_t o;
    uart_stm32_get_odom(&o);
    return (o.enc[0] + o.enc[1] + o.enc[2] + o.enc[3]) / 4;
}

static float enc_dist_mm(int32_t start) {
    return fabsf((float)(enc_avg() - start)) * ENC_MM_PER_PULSE;
}

/* ── Forward decls ─────────────────────────────────────────── */
static float norm_deg(float d);
float delta_deg(float cur, float tgt);

/* ── State ─────────────────────────────────────────────────── */
static volatile motion_state_t s_state = MOTION_IDLE;
static QueueHandle_t s_cmd_q = NULL;
static TaskHandle_t s_motion_task = NULL;
static volatile bool s_stop_flag = false;
static volatile bool s_dry_run = false;

/* ── Manual movement tracking ─────────────────────────────── */
static volatile bool s_manual_active = false;

static int32_t s_manual_start_enc = 0;
static float s_manual_start_yaw = 0;
static float s_round_start_angle = 0;   /* s_pose.angle_deg at round start, for delta */
static float s_manual_sign = 1;       /* +1=forward, -1=backward */
static bool  s_manual_is_turn = false; /* true=arc turn (dir=3/4, has linear+Vz) */
static bool  s_manual_is_spin = false;  /* true=in-place spin (spin=1/2, Vz only) */
static bool  s_tick_needs_reset = false; /* motion_tick must re-init on type switch */
static int64_t s_manual_start_us = 0;  /* timestamp when movement began */

/* ── Pose tracking ────────────────────────────────────────── */
static robot_pose_t s_pose = { .valid = true };  /* always valid �?pose tracks all movement */
static float s_yaw_offset = 0;  /* heading = IMU_yaw - offset; set on CMD:POS */

const robot_pose_t *motion_get_pose(void) { return &s_pose; }

/* ── Nav target for display ───────────────────────────────── */
static float  s_target_x = 0, s_target_y = 0;
static bool   s_target_valid = false;

void motion_set_target(float tx, float ty) {
    s_target_x = tx; s_target_y = ty; s_target_valid = true;
}

void motion_clear_target(void) { s_target_valid = false; }

bool motion_get_target(float *tx, float *ty) {
    if (!s_target_valid) return false;
    if (tx) *tx = s_target_x;
    if (ty) *ty = s_target_y;
    return true;
}

void motion_set_pose(float x, float y, float angle_deg) {
    s_pose.x_m = x; s_pose.y_m = y; s_pose.angle_deg = norm_deg(angle_deg);
    s_pose.valid = true;
    s_yaw_offset = uart_stm32_get_yaw() - s_pose.angle_deg;
    ESP_LOGI(TAG, "Pose set: (%.2f,%.2f) @ %.1f° yaw_offset=%.1f",
             (double)x, (double)y, (double)s_pose.angle_deg, (double)s_yaw_offset);
}

void motion_update_pose(float x, float y) {
    s_pose.x_m = x; s_pose.y_m = y;
    /* angle unchanged �?last known heading */
}

motion_state_t motion_get_state(void) { return s_state; }
bool motion_is_idle(void) { return s_state == MOTION_IDLE; }


/* ══════════════════════════════════════════════════════════�?
 * Primitives
 * ══════════════════════════════════════════════════════════�?*/

/* STM32 protocol: $D,S,0,C,0,0,0,0,0,0#  (10 values: dir[1], spin[3], speed_ctrl[7]) */
static void build_frame(char *buf, size_t sz, int dir, int spin, int speed_ctrl)
{ snprintf(buf, sz, "$%d,%d,0,%d,0,0,0,0,0,0#", dir, spin, speed_ctrl); }

/* Speed adjustment via protocol[7]: '2'=-100, '1'=+100.  CarSpeedControl clamps at [100,1000]. */
static void send_frame(const char *f)
{ for (int i = 0; i < 5; i++) { if (uart_stm32_send(f) == ESP_OK) break; vTaskDelay(pdMS_TO_TICKS(10)); } }

static void send_stop(void) {
    uart_stm32_send("$0,0,0,0,0,0,0,0,0,0#");
    vTaskDelay(pdMS_TO_TICKS(10));
    uart_stm32_send("$0,0,0,0,0,0,0,0,0,0#");
}

static float norm_deg(float d)
{ while (d > 360) d -= 360; while (d < 0) d += 360; return d; }

float delta_deg(float cur, float tgt)
{ float d = norm_deg(tgt) - norm_deg(cur); if (d > 180) d -= 360; if (d < -180) d += 360; return d; }

/* ══════════════════════════════════════════════════════════�?
 * Command queue types
 * ══════════════════════════════════════════════════════════�?*/

typedef enum { CMD_IDLE, CMD_NAV, CMD_SPIN } cmd_type_t;

typedef struct {
    cmd_type_t type;
    float tx, ty, cx, cy, ca;
    int   spin_dir;
} motion_cmd_t;


/* ══════════════════════════════════════════════════════════�?
 * Persistent motion task �?drains queue, latest wins
 * ══════════════════════════════════════════════════════════�?*/

static void motion_task(void *arg)
{
    (void)arg;
    motion_cmd_t cmd;
    while (1) {
        /* Block until a command arrives */
        if (xQueueReceive(s_cmd_q, &cmd, portMAX_DELAY) != pdTRUE) continue;

        ESP_LOGI(TAG, "Got cmd type=%d", (int)cmd.type);
        send_stop();
        vTaskDelay(pdMS_TO_TICKS(10));
        motion_tick();  /* refresh s_pose from latest IMU/encoder before nav */

        if (cmd.type == CMD_SPIN) {
            s_state = MOTION_SPINNING;
            char f[32];
            int spin = (cmd.spin_dir == 3) ? 1 : 2;  /* 1=SPIN_LEFT, 2=SPIN_RIGHT */

            build_frame(f, sizeof(f), 0, spin, 3);  /* turn at speed 300 */
            send_frame(f);

            /* Spin until a NEW command arrives (NAV or STOP) */
            while (xQueueReceive(s_cmd_q, &cmd, pdMS_TO_TICKS(100)) != pdTRUE) {
                /* nothing �?keep spinning */
            }
            send_stop();
            vTaskDelay(pdMS_TO_TICKS(10));

            if (cmd.type != CMD_NAV) {
                s_state = MOTION_IDLE;
                continue;  /* was a STOP or second SPIN */
            }
            /* fall through to NAV handling */
        }

        if (cmd.type == CMD_NAV) {
            motion_set_target(cmd.tx, cmd.ty);
            float dx = cmd.tx - s_pose.x_m, dy = cmd.ty - s_pose.y_m;
            float dist_m = sqrtf(dx * dx + dy * dy);

            if (dist_m < 0.01f) {
                s_state = MOTION_IDLE;
                tcp_client_send_raw("EXEC:DONE\r\n", 11);
                continue;
            }

            /* ── Turn ──────────────────────────────────── */
            s_state = MOTION_TURNING;
            float tgt_deg = atan2f(dy, dx) * 180.0f / 3.14159f;
            float delta   = delta_deg(s_pose.angle_deg, tgt_deg);

            ESP_LOGI(TAG, "%s NAV: (%.2f,%.2f)[%.1f°] �?(%.2f,%.2f) Δ=%.1f° dist=%.2fm",
                     "",
                     (double)s_pose.x_m, (double)s_pose.y_m, (double)s_pose.angle_deg,
                     (double)cmd.tx, (double)cmd.ty, (double)delta, (double)dist_m);

            if (fabsf(delta) >= TURN_TOLERANCE_DEG) {
                int spin = (delta > 0) ? 1 : 2;  /* in-place spin: 1=CCW, 2=CW */
                ESP_LOGI(TAG, "%s TURN: spin=%d(=%s) Δ=%.1f°",
                         "",
                         spin, spin==1?"CCW":"CW", (double)delta);
                float start_yaw = uart_stm32_get_yaw();
                char f[32];

                build_frame(f, sizeof(f), 0, spin, 3);  /* turn at speed 300 */
                send_frame(f);

                /* Two-stage closed-loop: fast then slow for precision */
                float acc = 0;
                float last_yaw = start_yaw;
                int timeout = 0;
                bool slowed = false;
                while (acc < fabsf(delta) - TURN_TOLERANCE_DEG && timeout < 200) {
                    vTaskDelay(pdMS_TO_TICKS(DRIVE_POLL_MS));
                    float cur = uart_stm32_get_yaw();
                    float da = fabsf(delta_deg(last_yaw, cur));
                    if (da < 30.0f) { acc += da; } else { ESP_LOGW(TAG, "  TURN da=%.1f filtered", (double)da); } last_yaw = cur;
                    timeout++;
                    if (!slowed && acc > fabsf(delta) - 15.0f) {
                        slowed = true;
                        /* '2' = -100: 300→200→100 */
                        char sf[32]; build_frame(sf, sizeof(sf), 0, 0, 2); send_frame(sf);
                        vTaskDelay(pdMS_TO_TICKS(10));
                        build_frame(sf, sizeof(sf), 0, 0, 2); send_frame(sf);
                        ESP_LOGI(TAG, "  TURN slowing to ~100 at acc=%.1f", (double)acc);
                    }
                    if (timeout % 10 == 0) {
                        ESP_LOGI(TAG, "  turn poll %d: cur=%.1f acc=%.1f/%.1f",
                                 timeout, (double)cur, (double)acc, (double)fabsf(delta));
                    }
                    if (xQueueReceive(s_cmd_q, &cmd, 0) == pdTRUE) break;
                }
                send_stop();
                /* Settle + correction loop */
                {
                    float ly = uart_stm32_get_yaw();
                    int sw = 0;
                    while (sw < 3) {
                        vTaskDelay(pdMS_TO_TICKS(30));
                        motion_tick();
                        float cy = uart_stm32_get_yaw();
                        if (fabsf(delta_deg(ly, cy)) < 1.0f) sw++; else sw = 0;
                        ly = cy;
                    }
                    /* Corrective turn if residual > 2° */
                    float residual = delta_deg(s_pose.angle_deg, tgt_deg);
                    if (fabsf(residual) > 2.0f) {
                        int rspin = (residual > 0) ? 1 : 2;
                        char cf[32]; build_frame(cf, sizeof(cf), 0, rspin, 0);
                        send_frame(cf);
                        float ra = 0, rly = uart_stm32_get_yaw();
                        int rt = 0;
                        while (ra < fabsf(residual) - 1.0f && rt < 50) {
                            vTaskDelay(pdMS_TO_TICKS(30));
                            float rcy = uart_stm32_get_yaw();
                            float rda = fabsf(delta_deg(rly, rcy));
                            if (rda < 30.0f) ra += rda;
                            rly = rcy; rt++;
                        }
                        send_stop();
                        vTaskDelay(pdMS_TO_TICKS(30));
                        ESP_LOGI(TAG, "TURN correction: residual=%.1f -> %.1f polled", (double)residual, (double)ra);
                    }
                }
                ESP_LOGI(TAG, "TURN done: start_yaw=%.1f acc=%.1f target=%.1f polls=%d",
                         (double)start_yaw, (double)acc, (double)fabsf(delta), timeout);

                if (xQueueReceive(s_cmd_q, &cmd, 0) == pdTRUE) { send_stop(); continue; }
            }

            /* ── Drive ──────────────────────────────────── */
            s_state = MOTION_MOVING;
            /* default speed 300 �?stable for both spin and drive */
            float target_mm = dist_m * 1000.0f;
            ESP_LOGI(TAG, "%s DRIVE: %.0fmm",
                     "", (double)target_mm);
            float imu_ref  = uart_stm32_get_yaw();
            float wld_ref  = tgt_deg;
            float last_odo = 0;
            int32_t start_enc = enc_avg();
            char f[32];
            build_frame(f, sizeof(f), 1, 0, 5);
            send_frame(f);

            int timeout = 0;
            while (timeout < 600) {
                vTaskDelay(pdMS_TO_TICKS(DRIVE_POLL_MS)); timeout++;

                float total_mm = enc_dist_mm(start_enc);
                float delta_mm = total_mm - last_odo;
                last_odo = total_mm;

                float imu_now   = uart_stm32_get_yaw();
                float drift_deg = delta_deg(imu_ref, imu_now);
                float live_hdg  = norm_deg(wld_ref + drift_deg);

                /* Direct dead-reckoning into s_pose (motion_tick only
                 * tracks position during manual movement) */
                {
                    float rad = live_hdg * 3.14159f / 180.0f;
                    s_pose.x_m += delta_mm / 1000.0f * cosf(rad);
                    s_pose.y_m += delta_mm / 1000.0f * sinf(rad);
                }
                s_pose.angle_deg = norm_deg(imu_now - s_yaw_offset);

                if (fabsf(drift_deg) > 3.0f) {
                    char cf[32]; build_frame(cf, sizeof(cf), drift_deg > 0 ? 4 : 3, 0, 0);
                    send_frame(cf); vTaskDelay(pdMS_TO_TICKS(30));
                    send_stop(); vTaskDelay(pdMS_TO_TICKS(10));
                    send_frame(f);
                    imu_ref = uart_stm32_get_yaw(); wld_ref = norm_deg(wld_ref + drift_deg);
                    start_enc = enc_avg(); last_odo = 0;
                }

                float rdx = cmd.tx - s_pose.x_m, rdy = cmd.ty - s_pose.y_m;
                if (sqrtf(rdx * rdx + rdy * rdy) < 0.02f) break;

                if (xQueueReceive(s_cmd_q, &cmd, 0) == pdTRUE) break;
            }
            send_stop(); vTaskDelay(pdMS_TO_TICKS(10));
            motion_tick();  /* final refresh */
            ESP_LOGI(TAG, "DRIVE done: target=%.0fmm enc=%.0fmm",
                     (double)(dist_m * 1000.0f), (double)enc_dist_mm(start_enc));

            if (xQueueReceive(s_cmd_q, &cmd, 0) == pdTRUE) continue;

            s_state = MOTION_IDLE;
            /* s_pose is tracked continuously by motion_tick -- no geometric overwrite */
            motion_clear_target();
            /* Report estimated pose back to PC so frontend map updates */
            {
                char buf[96];
                int len = snprintf(buf, sizeof(buf), "$POSE:x=%.3f,y=%.3f,a=%.1f\r\n",
                         (double)s_pose.x_m, (double)s_pose.y_m, (double)s_pose.angle_deg);
                tcp_client_send_raw(buf, len);
            }
            tcp_client_send_raw("EXEC:DONE\r\n", 11);
            ESP_LOGI(TAG, "%s Nav done", "");
        }
    }
}

/* ══════════════════════════════════════════════════════════�?
 * Public API
 * ══════════════════════════════════════════════════════════�?*/

static void queue_cmd(const motion_cmd_t *c)
{
    motion_cmd_t dummy;
    while (xQueueReceive(s_cmd_q, &dummy, 0) == pdTRUE) {}
    if (xQueueSend(s_cmd_q, c, pdMS_TO_TICKS(100)) != pdTRUE)
        ESP_LOGE(TAG, "queue full!");
}

esp_err_t motion_nav_to_pose(float tx, float ty, float cx, float cy, float ca)
{
    ESP_LOGI(TAG, "Queue NAV �?(%.2f,%.2f)", (double)tx, (double)ty);
    motion_cmd_t c = { .type = CMD_NAV, .tx = tx, .ty = ty, .cx = cx, .cy = cy, .ca = ca };
    queue_cmd(&c);
    return ESP_OK;
}

esp_err_t motion_spin(int dir)
{
    ESP_LOGI(TAG, "Queue SPIN dir=%d", dir);
    motion_cmd_t c = { .type = CMD_SPIN, .spin_dir = dir };
    queue_cmd(&c);
    return ESP_OK;
}

esp_err_t motion_stop(void)
{
    /* Always interrupt any in-progress auto-nav */
    {
        motion_cmd_t c = { .type = CMD_IDLE };
        queue_cmd(&c);
    }

    if (!s_manual_active) {
        send_stop();
        return ESP_OK;
    }

    ESP_LOGI(TAG, "=== ROUND END (STOP) ===");

    /* 1. Stop motors -- motion_tick continues accumulating during decel */
    send_stop();

    /* 2. Wait for encoder + yaw to settle, driving motion_tick directly */
    int32_t last_enc = enc_avg();
    float   last_yaw = uart_stm32_get_yaw();
    int     settled  = 0;
    while (settled < 4) {
        vTaskDelay(pdMS_TO_TICKS(30));
        motion_tick();                         /* guaranteed execution regardless of main loop */
        int32_t cur_enc = enc_avg();
        float   cur_yaw = uart_stm32_get_yaw();
        if (cur_enc == last_enc && fabsf(delta_deg(last_yaw, cur_yaw)) < 0.3f) {
            settled++;
        } else {
            settled = 0;
        }
        last_enc = cur_enc;
        last_yaw = cur_yaw;
    }

    /* 3. Motion settled -- use pose delta (continuously updated by motion_tick)
     *    instead of IMU snapshots, which are unreliable due to pipeline latency. */
    s_manual_active = false;
    motion_tick();  /* one final tick */
    float dist_mm = enc_dist_mm(s_manual_start_enc);
    float yaw_delta = delta_deg(s_round_start_angle, s_pose.angle_deg);
    ESP_LOGI(TAG, "  delta: pose %.1f->%.1f = %.1f",
             (double)s_round_start_angle, (double)s_pose.angle_deg, (double)yaw_delta);

    int32_t elapsed_ms = (int32_t)((esp_timer_get_time() - s_manual_start_us) / 1000);
    int32_t avg_spd = 0;
    if (s_manual_is_spin || s_manual_is_turn) {
        avg_spd = (elapsed_ms > 0) ? (int32_t)(fabsf(yaw_delta) * 1000.0f / (float)elapsed_ms) : 0;
    } else {
        float signed_dist = dist_mm * s_manual_sign;
        avg_spd = (elapsed_ms > 0) ? (int32_t)(fabsf(signed_dist) * 1000.0f / (float)elapsed_ms) : 0;
    }

    {
        char buf[160];
        int len = snprintf(buf, sizeof(buf),
            "$MOVE:d=%.0f,a=%.1f,t=%ld,v=%ld,x=%.3f,y=%.3f,h=%.1f\r\n",
            (double)(s_manual_is_spin ? 0.0f : dist_mm * s_manual_sign),
            (double)yaw_delta, (long)elapsed_ms, (long)avg_spd,
            (double)s_pose.x_m, (double)s_pose.y_m, (double)s_pose.angle_deg);
        tcp_client_send_raw(buf, len);
    }

    ESP_LOGI(TAG, "Manual %s: d=%.0fmm dY=%.1fdeg %ldms %ld%s pose=(%.2f,%.2f)@%.1fdeg",
             s_manual_is_spin ? "spin" : "move",
             (double)(s_manual_is_spin ? 0.0f : dist_mm * s_manual_sign),
             (double)yaw_delta, (long)elapsed_ms, (long)avg_spd,
             s_manual_is_spin ? "deg/s" : "mm/s",
             (double)s_pose.x_m, (double)s_pose.y_m, (double)s_pose.angle_deg);

    motion_clear_target();
    return ESP_OK;
}

esp_err_t motion_send_raw(const char *frame)
{
    if (!frame) return ESP_ERR_INVALID_ARG;

    /* STOP frames are handled exclusively by motion_stop() */
    /* STOP passes through; spin frames have dir=0 but spin≠0 — let them fall to handler */
    if (frame[0] == '$' && frame[1] == '0' && frame[3] != '1' && frame[3] != '2') {
        return uart_stm32_send(frame);
    }

    /* ── Manual movement tracking ────────────────────────── */
    if (frame[0] == '$' && (frame[1] >= '1' && frame[1] <= '4')) {
        /* Arc movement: dir=1..4 �?Vx �?0 for all */
        bool type_changed = !s_manual_active || s_manual_is_spin;
        if (type_changed) {
            s_manual_start_enc = enc_avg();
            s_manual_start_yaw = uart_stm32_get_yaw();
            s_manual_start_us  = esp_timer_get_time();
            s_round_start_angle = s_pose.angle_deg;
            s_tick_needs_reset = true;
        }
        s_manual_sign = (frame[1] == '2') ? -1.0f : 1.0f;
        s_manual_is_turn = (frame[1] == '3' || frame[1] == '4');
        s_manual_is_spin = false;
        s_manual_active = true;
    } else if (frame[0] == '$' && (frame[3] == '1' || frame[3] == '2')) {
        /* In-place spin: dir=0, spin=1|2 �?Vx=0 */
        bool type_changed = !s_manual_active || !s_manual_is_spin;
        if (type_changed) {
            s_manual_start_enc = enc_avg();
            s_manual_start_yaw = uart_stm32_get_yaw();
            s_manual_start_us  = esp_timer_get_time();
            s_round_start_angle = s_pose.angle_deg;
            s_tick_needs_reset = true;
        }
        s_manual_sign = 1.0f;
        s_manual_is_turn = false;
        s_manual_is_spin = true;
        s_manual_active = true;
    }

    return uart_stm32_send(frame);
}

void motion_tick(void)
{
    /* Heading from global offset — no per-tick delta accumulation */
    s_pose.angle_deg = norm_deg(uart_stm32_get_yaw() - s_yaw_offset);

    if (s_manual_active && !s_manual_is_spin) {
        static int32_t s_tick_enc = 0;
        static bool    s_tick_init = false;
        if (!s_tick_init || s_tick_needs_reset) {
            s_tick_needs_reset = false;
            s_tick_enc = s_manual_start_enc;
            s_tick_init = true;
        }
        float dist_mm = fabsf((float)(enc_avg() - s_tick_enc)) * ENC_MM_PER_PULSE;
        float rad = s_pose.angle_deg * 3.14159f / 180.0f;
        float signed_dist = dist_mm * s_manual_sign;
        s_pose.x_m += signed_dist / 1000.0f * cosf(rad);
        s_pose.y_m += signed_dist / 1000.0f * sinf(rad);
        s_tick_enc = enc_avg();
    }
}

esp_err_t motion_init(void)
{
    s_cmd_q = xQueueCreate(3, sizeof(motion_cmd_t));
    if (!s_cmd_q) return ESP_ERR_NO_MEM;
    if (xTaskCreatePinnedToCore(motion_task, "motion", 4096, NULL,
                                tskIDLE_PRIORITY + 2, &s_motion_task, 0) != pdPASS) {
        vQueueDelete(s_cmd_q);
        return ESP_ERR_NO_MEM;
    }
    s_state = MOTION_IDLE;
    ESP_LOGI(TAG, "Motion ready");
    return ESP_OK;
}

void motion_set_dry_run(bool enable) { s_dry_run = enable; }
bool motion_get_dry_run(void) { return s_dry_run; }

/* Backward-compat */
esp_err_t motion_nav_to(float x, float y, float speed)
{ (void)speed; return motion_nav_to_pose(x, y, 0, 0, 0); }

