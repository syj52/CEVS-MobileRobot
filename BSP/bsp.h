#ifndef __BSP_H_
#define __BSP_H_

#define bool _Bool
#define true 1
#define false 0

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <Time.h>

#include "main.h"
#include "adc.h"
#include "i2c.h"
#include "tim.h"
#include "usart.h"
#include "gpio.h"
#include "delay.h"

#include "app_rgb.h"
#include "bsp_rgb.h"
#include "bsp_buzzer.h"
#include "bsp_vol.h"

#include "bsp_iravoid.h"
#include "app_iravoid.h"
#include "bsp_irtracking.h"
#include "app_irtracking.h"
#include "bsp_ultrasonic.h"
#include "app_ultrasonic.h"

#include "bsp_usart1.h"
#include "bsp_uart5.h"
#include "bsp_oled.h"
#include "bsp_bluetooth.h"
#include "app_bluetooth.h"
#include "IMU/imu_uart_driver.h"

#define IMU_DEBUG 0  /* 设为 1 开启原始字节诊断 / set to 1 for raw byte diag */

#include "pwm_servo.h"


#include "bsp_encoder.h"
#include "bsp_motor.h"
#include "bsp_tim.h"
#include "bsp_PID_motor.h"
#include "app_motor.h"


extern uint8_t g_servo_falg;

void BSP_Init(void);
void BSP_Loop(void);

#endif
