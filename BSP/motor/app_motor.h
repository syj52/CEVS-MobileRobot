#ifndef __APP_MOTOR_H
#define __APP_MOTOR_H

#include "bsp.h"

// 450RPM电机，轮子转一整圈，编码器获得的脉冲数=减速比*码盘线数*编码器脉冲（20*13*4）
//450RPM motor, with one complete turn of the wheel,
//the number of pulses obtained by the
//encoder=reduction ratio * number of encoder wires * encoder pulses (20 * 13 * 4)
#define ENCODER_CIRCLE_450 (1040.0f)

// Half of the sum of the distances between the car chassis motors 小车底盘电机间距之和的一半
#define STM32Car_APB (159.0f) //170.5  147.5

// The displacement of a wheel in one complete revolution, measured in meters 轮子转一整圈的位移，单位为米
#define MECANUM_CIRCLE_MM (204.203f)

// 停止模式，STOP_FREE表示自由停止，STOP_BRAKE表示刹车。
//Stop mode, STOP_ FREE stands for free stop, STOP_ BRAKE stands for braking.
typedef enum _stop_mode
{
    STOP_FREE = 0,
    STOP_BRAKE
} stop_mode_t;

typedef enum _motion_state
{
    MOTION_STOP = 0,
    MOTION_RUN,
    MOTION_BACK,
    MOTION_LEFT,
    MOTION_RIGHT,
    MOTION_SPIN_LEFT,
    MOTION_SPIN_RIGHT,
    MOTION_BRAKE,

    MOTION_MAX_STATE
} motion_state_t;

typedef struct _car_data
{
    int16_t Vx;
    int16_t Vy;
    int16_t Vz;
} car_data_t;

void Motion_Stop(uint8_t brake);
void Motion_Set_Pwm(int16_t Motor_1, int16_t Motor_2, int16_t Motor_3, int16_t Motor_4);
void Motion_Ctrl(int16_t V_x, int16_t V_y, int16_t V_z);
void Motion_Ctrl_State(uint8_t state, uint16_t speed, uint8_t adjust);

void Motion_Get_Encoder(void);
void Motion_Set_Speed(int16_t speed_m1, int16_t speed_m2, int16_t speed_m3, int16_t speed_m4);

void Motion_Handle(void);

void Motion_Get_Speed(car_data_t *car);
void Motion_Yaw_Calc(float yaw);

void Motion_Set_Yaw_Adjust(uint8_t adjust);
uint8_t Motion_Get_Yaw_Adjust(void);

uint8_t Motion_Get_Car_Type(void);
float Motion_Get_Circle_MM(void);
float Motion_Get_APB(void);

void Motion_Get_Motor_Speed(float *speed);

void Wheel_Yaw_Calc(float yaw);
void wheel_State(uint8_t state, uint16_t speed);
void wheel_State_YAW(uint8_t state, uint16_t speed, uint8_t adjust);
void wheel_Ctrl(int16_t V_x, int16_t V_y, int16_t V_z);

#endif
