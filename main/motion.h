#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

esp_err_t motion_init(void);

/** Robot pose — tracked from CMD:NAV cx/cy/ca, updated after each move. */
typedef struct {
    float x_m, y_m;       /* position in world metres */
    float angle_deg;      /* heading in degrees */
    bool  valid;           /* true once initialised */
} robot_pose_t;

const robot_pose_t *motion_get_pose(void);
void motion_set_pose(float x, float y, float angle_deg);
void motion_update_pose(float x, float y);

/** Single-waypoint navigation.
 *  If a command is already executing, it is cancelled and replaced. */
esp_err_t motion_nav_to_pose(float target_x, float target_y,
                             float cur_x, float cur_y, float cur_angle_deg);

/** Continuous spin — cancel with motion_stop() or a new nav command */
esp_err_t motion_spin(int dir);   /* 3=CCW(left), 4=CW(right) */

esp_err_t motion_stop(void);

typedef enum { MOTION_IDLE, MOTION_TURNING, MOTION_MOVING, MOTION_SPINNING } motion_state_t;
motion_state_t motion_get_state(void);
bool motion_is_idle(void);

/** Calibrate open-loop timing */
void motion_set_turn_cal(float ms_per_deg);
void motion_set_drive_cal(float ms_per_mm);
/** Raw motor frame (for manual control) */
esp_err_t motion_send_raw(const char *frame);

/** Auto-stop watchdog for raw manual control */
void motion_tick(void);

/** Shortest signed angular difference in degrees [-180,180]. CCW positive. */
float delta_deg(float cur, float tgt);

/** Navigation target for display overlay */
void motion_set_target(float tx, float ty);
void motion_clear_target(void);
bool motion_get_target(float *tx, float *ty);
