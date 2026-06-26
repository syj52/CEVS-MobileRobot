/*
 * bsp_motor.h
 *
 *  Created on: Sep 26, 2023
 *      Author: YB-101
 */

#ifndef BSP_MOTOR_H_
#define BSP_MOTOR_H_

#include "main.h"
#include "tim.h"

#define PWM_M1_A TIM8->CCR1
#define PWM_M1_B TIM8->CCR2
#define PWM_M2_A TIM8->CCR3
#define PWM_M2_B TIM8->CCR4

#define PWM_M3_A TIM1->CCR1
#define PWM_M3_B TIM1->CCR2
#define PWM_M4_A TIM1->CCR3
#define PWM_M4_B TIM1->CCR4

#define MOTOR_IGNORE_PULSE (2000)
#define MOTOR_MAX_PULSE (3600)
#define MOTOR_FREQ_DIVIDE (0)

// MOTOR: M1 M2 M3 M4
// MOTOR: L1 L2 R1 R2
typedef enum
{
	MOTOR_ID_M1 = 0,
	MOTOR_ID_M2,
	MOTOR_ID_M3,
	MOTOR_ID_M4,
	MAX_MOTOR
} Motor_ID;

void Motor_Set_Pwm(uint8_t id, int16_t speed);
void Motor_Stop(uint8_t brake);

#endif /* BSP_MOTOR_H_ */
